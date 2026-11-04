/** Lorebook portraits: tags from the text model, NovelAI image from a mocked endpoint, stored per entry. */
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'lore-portrait-check-only'

/** Minimal single-file ZIP, deflated like NovelAI's response. */
function zip(name: string, data: Buffer) {
  const compressed = deflateRawSync(data)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(8, 8)
  local.writeUInt32LE(compressed.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(8, 10)
  central.writeUInt32LE(compressed.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0, 42)
  const localPart = Buffer.concat([local, Buffer.from(name), compressed])
  const centralPart = Buffer.concat([central, Buffer.from(name)])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(centralPart.length, 12)
  end.writeUInt32LE(localPart.length, 16)
  return Buffer.concat([localPart, centralPart, end])
}

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initLogStore } = await import('../llm/logstore')
  const { default: writer } = await import('../routes/writer')
  const { sanitizeTags } = await import('../llm/lore-portrait')
  const db = getDB()
  initSchema()
  initLogStore()
  const text = Number(
    db
      .prepare(
        "INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES ('text','https://text.invalid/v1','glm','text-secret')",
      )
      .run().lastInsertRowid,
  )
  const image = Number(
    db
      .prepare(
        "INSERT INTO llm_configs(name,interface_format,base_url,model_name,api_key) VALUES ('image','NovelAI Image','https://image.novelai.net','nai-diffusion-4-5-full','image-secret')",
      )
      .run().lastInsertRowid,
  )
  const novel = Number(
    db.prepare("INSERT INTO novels(title,creator_username) VALUES ('形象测试','author')").run().lastInsertRowid,
  )
  const app = express()
  app.use(express.json())
  app.use('/novels', writer)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', r))
  const realFetch = globalThis.fetch
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from('fake-png-body'),
  ])
  let tagOutput = '1girl, silver hair, 林远舟, pilot suit, spaceship interior, looking at viewer'
  let imageStatus = 200
  const imageBodies: any[] = []
  globalThis.fetch = (async (url: any, options: any) => {
    if (String(url) === 'https://text.invalid/v1/chat/completions') {
      assert.equal(options.headers.Authorization, 'Bearer text-secret')
      const body = JSON.parse(options.body)
      if (body.messages[0].content.includes('character profile'))
        assert(body.messages[1].content.includes('身份：飞行员'))
      else assert(/废弃空间站|边境星站/.test(body.messages[1].content))
      return Response.json({ choices: [{ message: { content: tagOutput }, finish_reason: 'stop' }] })
    }
    assert.equal(String(url), 'https://image.novelai.net/ai/generate-image')
    assert.equal(options.headers.Authorization, 'Bearer image-secret')
    const body = JSON.parse(options.body)
    imageBodies.push(body)
    if (imageStatus !== 200) return new Response('quota image-secret', { status: imageStatus })
    return new Response(zip('image_0.png', png))
  }) as typeof fetch
  const token = jwt.sign({ username: 'author', role: 'user' }, process.env.JWT_SECRET!)
  const other = jwt.sign({ username: 'other', role: 'user' }, process.env.JWT_SECRET!)
  const call = async (path: string, body?: any, status = 200, who = token) => {
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}/writer${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    assert.equal(r.status, status, await r.clone().text())
    return r
  }
  const entry = {
    id: 'char-1',
    title: '林远舟',
    text: '身份：飞行员。银色短发，常穿旧飞行服。',
    keys: ['林远舟'],
    enabled: true,
    always_on: false,
    category: '人物',
  }
  const settings = {
    model_id: String(text),
    image_model_id: String(image),
    system_prompt: '',
    memory: '',
    lorebook: [],
    temperature: 0.7,
    max_output_tokens: 1024,
    recent_context_chars: 0,
    context_tokens: 8192,
  }
  try {
    const result: any = await (await call('/lore/portrait', { settings, lore_entry: entry })).json()
    assert.equal(result.entry_id, 'char-1')
    assert(!/[\u4e00-\u9fff]/.test(result.prompt), 'Chinese names never reach the image model')
    assert(result.prompt.startsWith('1girl, silver hair, pilot suit'))
    const sent = imageBodies[0]
    assert.equal(sent.model, 'nai-diffusion-4-5-full')
    assert.equal(sent.parameters.width * sent.parameters.height <= 1048576, true)
    assert.equal(sent.parameters.steps, 28)
    assert.equal(sent.parameters.n_samples, 1)
    assert.equal(sent.parameters.v4_prompt.caption.base_caption, result.prompt)
    assert(sent.parameters.v4_negative_prompt.caption.base_caption.includes('nsfw'))
    const stored = await call('/lore/portrait/char-1')
    assert.equal(stored.headers.get('content-type'), 'image/png')
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), png)
    assert.deepEqual(
      ((await (await call('/lore/portraits')).json()) as any).items.map((i: any) => i.entry_id),
      ['char-1'],
    )
    console.log('✓ 中文人物设定转为英文画面标签，NovelAI 免费额度参数生图，ZIP 解包后按条目保存并可读取')

    imageStatus = 429
    const before = db.prepare('SELECT updated_at FROM lore_portraits WHERE entry_id=?').get('char-1')
    const failed: any = await (await call('/lore/portrait', { settings, lore_entry: entry }, 400)).json()
    assert(!failed.message.includes('image-secret'))
    assert.match(failed.message, /429/)
    assert.equal(imageBodies.length, 2, 'No automatic retry after an image failure')
    assert.deepEqual(db.prepare('SELECT updated_at FROM lore_portraits WHERE entry_id=?').get('char-1'), before)
    imageStatus = 200
    tagOutput = '人物，银发，飞行员'
    await call('/lore/portrait', { settings, lore_entry: entry }, 400)
    assert.equal(imageBodies.length, 2, 'Unusable tags stop before the image call')
    console.log('✓ 生图失败或标签无效时保留旧形象、不重试、错误信息脱敏')

    await call('/lore/portrait', { settings: { ...settings, image_model_id: undefined }, lore_entry: entry }, 400)
    await call('/lore/portrait', { settings: { ...settings, image_model_id: String(text) }, lore_entry: entry }, 400)
    await call('/lore/portrait', { settings: { ...settings, model_id: String(image) }, lore_entry: entry }, 400)
    await call('/lore/portrait', { settings, lore_entry: entry }, 404, other)
    await call('/lore/portrait/char-1', undefined, 404, other)
    await call('/lore/portrait/missing', undefined, 404)
    assert.equal(imageBodies.length, 2)
    assert.equal(sanitizeTags('Tags: "1boy", short hair, 黑发, armor\nextra line'), '1boy, short hair, armor')
    assert.equal(sanitizeTags('1girl, solo, bar interior, no humans, neon'), 'bar interior, no humans, neon')
    console.log('✓ 未选或错选生图模型、文本模型误用生图配置、越权访问均被拒绝，不调用上游')

    tagOutput = 'no humans, frontier space station, docking bay, neon signs, night'
    const world = {
      ...entry,
      id: 'world-1',
      title: '边境星站',
      text: '边境星站：位于星域边缘的补给站，酒吧与船坞混杂。',
      category: '世界',
    }
    const scene: any = await (await call('/lore/portrait', { settings, lore_entry: world })).json()
    assert(scene.prompt.startsWith('no humans, frontier space station'))
    console.log('✓ 非人物条目按场景描述生成背景图，按条目单独保存')

    tagOutput = 'no humans, abandoned space station, dim corridor, floating debris, cold blue lighting'
    db.prepare(
      "INSERT INTO novel_chapters(novel_id,chapter_number,title,outline,content) VALUES (?,1,'残骸','林远舟潜入废弃空间站，寻找父亲留下的坐标。','')",
    ).run(novel)
    db.prepare('INSERT INTO novel_chapters(novel_id,chapter_number,title) VALUES (?,2,?)').run(novel, '空章')
    const background: any = await (await call('/chapter/1/background', { settings })).json()
    assert.equal(background.chapter_idx, 1)
    assert(background.prompt.startsWith('no humans, abandoned space station'))
    assert(imageBodies.at(-1).parameters.v4_prompt.caption.base_caption === background.prompt)
    const bg = await call('/chapter/1/background')
    assert.deepEqual(Buffer.from(await bg.arrayBuffer()), png)
    assert.deepEqual(
      ((await (await call('/chapter-backgrounds')).json()) as any).items.map((i: any) => i.chapter_idx),
      [1],
    )
    const calls = imageBodies.length
    await call('/chapter/2/background', { settings }, 400)
    await call('/chapter/9/background', { settings }, 400)
    await call('/chapter/1/background', { settings }, 404, other)
    await call('/chapter/1/background', undefined, 404, other)
    assert.equal(imageBodies.length, calls)
    db.prepare('DELETE FROM novel_chapters WHERE novel_id=? AND chapter_number=1').run(novel)
    assert.equal((db.prepare('SELECT count(*) AS n FROM chapter_backgrounds').get() as any).n, 0)
    console.log(
      '✓ 章节背景图取自已保存的标题、台本与开头正文，按章保存；空章、不存在的章与越权访问被拒绝，删章时一并清理',
    )
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
    db.close()
  }
}
main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
