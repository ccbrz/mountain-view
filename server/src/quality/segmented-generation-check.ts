/** Segmented generation: cut responses are continued automatically, trailing script events are written, skips are reported. */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'segmented-check-only'

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initLogStore } = await import('../llm/logstore')
  const { default: writer } = await import('../routes/writer')
  const { joinSegments, parseCoverage } = await import('../llm/segmented-generation')
  const db = getDB()
  initSchema()
  initLogStore()
  db.prepare(
    "INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES ('glm','https://glm.invalid/v1','glm-4-6','k')",
  ).run()
  const novel = Number(
    db.prepare("INSERT INTO novels(title,creator_username) VALUES ('分段','author')").run().lastInsertRowid,
  )
  const app = express()
  app.use(express.json({ limit: '4mb' }))
  app.use('/novels', writer)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', r))
  const realFetch = globalThis.fetch
  const sse = (text: string, finish: string | null) =>
    new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
        (finish
          ? `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`
          : ''),
    )
  let script: (body: any) => Response
  const sent: any[] = []
  globalThis.fetch = (async (_url: any, options: any) => {
    const body = JSON.parse(options.body)
    sent.push(body)
    return script(body)
  }) as typeof fetch
  const token = jwt.sign({ username: 'author', role: 'user' }, process.env.JWT_SECRET!)
  const settings = {
    model_id: '1',
    system_prompt: '',
    memory: '',
    memory_through_chapter: 0,
    lorebook: [],
    temperature: 0.7,
    max_output_tokens: 4096,
    recent_context_chars: 0,
    context_tokens: 32768,
  }
  const input = {
    chapter_idx: 1,
    raw_script: '林远舟走进酒吧。\n老赵答应借船。\n两人约定明早出发。',
    title: '借船',
    author_note: '',
    content: '',
    settings,
    mode: 'write',
  }
  const generate = async () => {
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}/writer/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    const data: any = await r.json()
    assert.equal(r.status, 200, JSON.stringify(data))
    return data
  }
  const isCoverage = (body: any) => body.messages[0].content.startsWith('你是小说台本核对员')
  try {
    assert.equal(joinSegments('他刚想说话，老赵却', '摆了摆手。'), '他刚想说话，老赵却摆了摆手。')
    assert.equal(joinSegments('他点了点头。', '\n第二天。'), '他点了点头。\n\n第二天。')
    assert.deepEqual(parseCoverage('{"last_written":2,"missing":[1,3]}', 3), {
      last_written: 2,
      trailing: [3],
      skipped: [1],
      beyond_end: false,
    })
    assert.equal(parseCoverage('不是 JSON', 3), null)
    // Observed from Xialong: claims the last event was written yet lists nearly every event as missing.
    assert.equal(parseCoverage('{"last_written":58,"missing":[1,2,3,4,5,6,7,8,9,10,11,12,16,17,18]}', 20), null)
    const { stripProseMarkers } = await import('../llm/segmented-generation')
    assert.equal(stripProseMarkers('他望向前方。\n\n\n[字数统计：5479]'), '他望向前方。')
    assert.equal(stripProseMarkers('他望向前方。\n\n[第一章 完]\n（本章完）'), '他望向前方。')
    assert.equal(stripProseMarkers('“完了。”他说。'), '“完了。”他说。')

    // Cut mid-sentence → continued; coverage finds event 3 unwritten → one more segment for it.
    let step = 0
    script = body => {
      step++
      if (isCoverage(body))
        return Response.json({
          choices: [{ message: { content: '{"last_written":2,"missing":[3]}' }, finish_reason: 'stop' }],
        })
      if (step === 1) return sse('林远舟走进酒吧，', null)
      if (step === 2) return sse('找到了老赵。老赵答应借船。', 'stop')
      return sse('两人约定明早出发。', 'stop')
    }
    const done = await generate()
    assert.equal(done.content, '林远舟走进酒吧，找到了老赵。老赵答应借船。\n\n两人约定明早出发。')
    assert.equal(done.incomplete, false)
    assert.equal(done.segments, 3)
    assert(sent[1].messages[1].content.includes('现有正文在半句处中断'))
    assert(
      sent[3].messages[1].content.includes('台本中以下事件尚未写到') &&
        sent[3].messages[1].content.includes('两人约定明早出发'),
    )
    console.log('✓ 断流自动接续成完整一章，半句处直接衔接；台本末尾未写到的事件自动补写')

    // Same flow over SSE: deltas preview the prose, `done` carries the identical authoritative result.
    step = 0
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}/writer/generate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...input, stream: true }),
    })
    assert.match(r.headers.get('content-type') || '', /text\/event-stream/)
    const events = (await r.text())
      .split('\n\n')
      .filter(Boolean)
      .map(block => JSON.parse(block.replace(/^data: /, '')))
    let preview = ''
    for (const e of events) preview = e.type === 'start' ? e.base : preview + (e.text || e.separator || '')
    const final = events.at(-1)
    assert.equal(final.type, 'done')
    assert.equal(final.result.content, done.content)
    assert.equal(preview, '林远舟走进酒吧，找到了老赵。老赵答应借船。\n\n两人约定明早出发。')
    assert(events.some(e => e.type === 'status' && e.status.includes('核对台本')))
    console.log('✓ 流式生成逐段推送预览，最终结果与非流式一致')

    // Skipped middle events cannot be appended; they are reported instead.
    sent.length = 0
    script = body =>
      isCoverage(body)
        ? Response.json({
            choices: [{ message: { content: '{"last_written":3,"missing":[2]}' }, finish_reason: 'stop' }],
          })
        : sse('林远舟走进酒吧。两人约定明早出发。', 'stop')
    const skipped = await generate()
    assert.equal(skipped.segments, 1)
    assert(skipped.warnings.some((w: string) => w.includes('第 2 项可能被跳过')))
    console.log('✓ 中间漏写的事件不硬补，明确提示作者核对')

    // Always cut: stops at the segment cap and keeps an unfinished draft.
    sent.length = 0
    script = () => sse('一直写不完，', null)
    const capped = await generate()
    assert.equal(capped.segments, 4)
    assert.equal(capped.incomplete, true)
    assert.equal(capped.content, '一直写不完，'.repeat(4))
    assert.equal(sent.length, 4)
    console.log('✓ 达到分段上限仍未写完时保留为未完成草稿，不无限调用')
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
