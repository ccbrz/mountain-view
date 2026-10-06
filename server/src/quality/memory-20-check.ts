/** 真模型 20 章实验；业务库只读，运行库在内存，证据写独立目录。会产生模型调用费用。
 * pnpm --filter server test:memory-20 [输出目录]；同一目录可从完整章节检查点继续。
 * 不自动评“通过”：完整正文/状态/提示词供人工按 fixture 的独立答案核对。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import express from 'express'
import jwt from 'jsonwebtoken'
import { architecture, characters, chapters, checks } from './memory-20-fixture'

const sourcePath = process.env.DB_PATH || path.resolve(__dirname, '../../../data/app.db')
const out = path.resolve(process.argv[2] || path.resolve(__dirname, `../../../demo-output/memory-20-${new Date().toISOString().replace(/[:.]/g, '-')}`))
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'isolated-memory-20-check'

async function main() {
  fs.mkdirSync(out, { recursive: true })
  const source = new Database(sourcePath, { readonly: true })
  const original = source.prepare('SELECT llm_config, embedding_config FROM novels ORDER BY id LIMIT 1').get() as any
  assert(original, '需要已有小说的任务模型配置')
  const configs = source.prepare('SELECT * FROM llm_configs').all() as any[]
  source.close()
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initLogStore } = await import('../llm/logstore')
  const { initVectorStore } = await import('../llm/vectorstore')
  const { getLLMConfigByName } = await import('../llm/config')
  const { requireProgressBeforeChapter, saveProgressSnapshot, progressBeforeChapter } = await import('../llm/doc-snapshots')
  const { invokeWithRetry } = await import('../llm/invoke')
  const { default: generator } = await import('../routes/novel-generator')
  const db = getDB()
  initSchema(); initLogStore(); initVectorStore()
  // 只限制本次实验的索引预检；服务不可用时不让 20 章分别等待 600 秒，也不使用模拟向量。
  const realFetch = globalThis.fetch
  let embeddingFailure = ''
  globalThis.fetch = (async (url: any, options: any) => {
    if (!String(url).endsWith('/embeddings')) return realFetch(url, options)
    if (embeddingFailure) throw new Error(embeddingFailure)
    try {
      const signals = [AbortSignal.timeout(30000), ...(options?.signal ? [options.signal] : [])]
      const res = await realFetch(url, { ...options, signal: AbortSignal.any(signals) })
      // 将读取响应体也纳入时限，并保留实际 API 状态。
      const body = await res.text()
      if (!res.ok) embeddingFailure = `本次实验 Embedding 预检失败（HTTP ${res.status}），后续索引标为未完成`
      return new Response(body, { status: res.status, headers: res.headers })
    } catch (e: any) {
      embeddingFailure = `本次实验 Embedding 预检失败（${e.name}），后续索引标为未完成`
      console.log(embeddingFailure)
      throw new Error(embeddingFailure)
    }
  }) as typeof fetch
  for (const c of configs) db.prepare(`INSERT INTO llm_configs
    (name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(c.name, c.interface_format, c.base_url, c.model_name, c.api_key, c.temperature, c.max_tokens, c.timeout)
  const id = Number(db.prepare(`INSERT INTO novels
    (title, creator_username, llm_config, embedding_config, num_chapters, word_number)
    VALUES ('雾汀港：20章记忆实验', 'memory-test', ?, ?, 20, 2000)`)
    .run(original.llm_config, original.embedding_config).lastInsertRowid)
  for (const [type, content] of [['architecture', architecture], ['characters', characters]]) {
    db.prepare('INSERT INTO novel_docs (novel_id, doc_type, content) VALUES (?, ?, ?)').run(id, type, content)
  }
  const modelMap = original.llm_config.startsWith('{') ? JSON.parse(original.llm_config) : { chapter: original.llm_config, finalize: original.llm_config }
  const manifest = { fixture: '雾汀港-v1', chapters: 20, targetWords: 2000, architecture, characters, checks,
    models: configs.map(c => ({ name: c.name, model: c.model_name, temperature: c.temperature, max_tokens: c.max_tokens })),
    tasks: modelMap, embedding: original.embedding_config }
  const manifestPath = path.join(out, 'manifest.json')
  if (fs.existsSync(manifestPath)) assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), manifest, '恢复运行必须使用相同模型配置和样本')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  // 保存的证据无配置密钥；服务错误偶尔会回显请求内容，额外剔除已知密钥。
  const safe = (value: unknown) => configs.reduce((s, c) => c.api_key ? s.split(c.api_key).join('[REDACTED]') : s, JSON.stringify(value, null, 2))
  const write = (file: string, value: unknown) => fs.writeFileSync(path.join(out, file), safe(value))
  const logs = () => db.prepare('SELECT task, model_name, system_prompt, user_prompt, response, duration_ms, input_tokens, output_tokens, status, error FROM llm_call_logs ORDER BY timestamp, rowid').all()
  const app = express()
  app.use(express.json()); app.use('/novels', generator)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const token = jwt.sign({ username: 'memory-test', role: 'admin' }, process.env.JWT_SECRET!)
  async function request(method: string, route: string, body: unknown = {}) {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${id}${route}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    const data: any = await res.json()
    if (!res.ok) throw new Error(safe({ route, status: res.status, data }))
    return data
  }
  const completed: any[] = []
  try {
    console.log(`输出：${out}`)
    for (const [i, [title, outline]] of chapters.entries()) {
      const n = i + 1, prefix = `ch${String(n).padStart(2, '0')}`
      const checkpointPath = path.join(out, `${prefix}.json`)
      if (fs.existsSync(checkpointPath)) {
        const saved = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'))
        assert.equal(saved.outline, outline)
        db.prepare(`INSERT INTO novel_chapters (novel_id, chapter_number, title, outline, content, status, word_count, index_status)
          VALUES (?, ?, ?, ?, ?, 'finalized', ?, ?)`)
          .run(id, n, title, outline, saved.content, saved.wordCount, saved.indexStatus)
        saveProgressSnapshot(db, id, n + 1, saved.state)
        for (const v of saved.vectors) db.prepare('INSERT INTO vector_embeddings (id, novel_id, text, metadata_json, embedding) VALUES (?, ?, ?, ?, ?)')
          .run(`restored-${n}-${v.index}`, id, v.text, v.metadata_json, Buffer.from(v.embedding, 'base64'))
        completed.push(saved)
        console.log(`恢复 ${n}/20：${saved.wordCount} 字`)
        continue
      }
      const draftPath = path.join(out, `${prefix}.md`)
      const existingDraft = fs.existsSync(draftPath) ? fs.readFileSync(draftPath, 'utf8') : ''
      await request('POST', '/chapters', { chapter_number: n, title, outline, content: existingDraft })
      console.log(`起草 ${n}/20：${title}`)
      const start = Date.now()
      if (!existingDraft) await request('POST', `/generate/chapter/${n}`)
      const chapter = db.prepare('SELECT content, word_count FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(id, n) as any
      fs.writeFileSync(path.join(out, `${prefix}.md`), chapter.content)
      console.log(`定稿 ${n}/20：${chapter.word_count} 字`)
      const finalized = await request('POST', `/generate/finalize/${n}`)
      const state = requireProgressBeforeChapter(db, id, n + 1)
      const vectors = (db.prepare("SELECT text, metadata_json, embedding FROM vector_embeddings WHERE novel_id = ? AND json_extract(metadata_json, '$.chapter') = ?").all(id, n) as any[])
        .map((v, index) => ({ ...v, index, embedding: v.embedding.toString('base64') }))
      const indexStatus = (db.prepare('SELECT index_status FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(id, n) as any).index_status
      const chapterLogs = logs().filter((l: any) => l.task === `chapter:${n}` || l.task.startsWith(`finalize:${n}`))
      const checkpoint = { chapter: n, title, outline, content: chapter.content, wordCount: chapter.word_count,
        state, vectors, indexStatus, warning: finalized.warning, durationMs: Date.now() - start, logs: chapterLogs }
      write(`${prefix}.json`, checkpoint)
      completed.push(checkpoint)
      write('calls.json', logs())
      console.log(`完成 ${n}/20：事实 ${state!.facts.length}，伏笔 ${state!.hooks.length}，索引 ${indexStatus}${finalized.warning ? '（有警告）' : ''}`)
    }

    const questions = [
      '沈砚左手有什么持续的身体限制？是否有明确治愈？',
      '唯一的灯塔铜钥匙现在在哪里、能否用于开门？',
      '沈砚、顾澜、季叔分别是否已经正式知道闻舟曾任什么职务？',
      '航道账由谁保管？调包者与动机是否已经查清？',
      '初次拜访季叔时约定的敲门节奏和答话原句是什么？',
      '初次拜访时黑陶碗下面是什么颜色、多少粒的东西，用来记什么？',
    ]
    const probeConfig = getLLMConfigByName(modelMap.consistency || modelMap.finalize || modelMap.chapter)
    assert(probeConfig)
    for (const n of [5, 10, 15, 20]) {
      const file = `probe-${n}.json`
      if (fs.existsSync(path.join(out, file))) continue
      const context = progressBeforeChapter(db, id, n + 1)
      const system = '你是小说连续性检查助手。只能依据给出的截至该章的上下文回答；未提供的信息写“证据不足”，不能借助后续剧情或猜测。输出 JSON 数组，每项含 question、answer、quote（逐字引用上下文证据；无证据为空）。'
      const user = `截至第${n}章的上下文：\n${context}\n\n逐项回答：\n${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`
      console.log(`记忆问答检查点 ${n}/20`)
      const response = await invokeWithRetry(probeConfig, system, user, 3, { novel_id: id, task: `memory-probe:${n}` })
      write(file, { chapter: n, questions, context, response })
    }
    write('calls.json', logs())
    write('summary.json', { completed: completed.length, totalWords: completed.reduce((s, c) => s + c.wordCount, 0),
      chapters: completed.map(c => ({ chapter: c.chapter, wordCount: c.wordCount, facts: c.state.facts.length, hooks: c.state.hooks.length,
        contextCharacters: progressBeforeChapter(db, id, c.chapter + 1).length, indexStatus: c.indexStatus, warning: c.warning, durationMs: c.durationMs })),
      embeddingFailure, embeddingPreflightTimeoutSeconds: 30,
      notice: '执行完成不代表质量通过；按 manifest.checks 核对正文、快照和提示词。问答仅测状态记忆，不代替完整起草链路。Embedding 首次失败后本轮后续索引停止重试，无模拟向量。' })
    console.log(`20 章和 4 个问答检查点执行完成，等待证据评阅：${out}`)
  } finally {
    write('last-run-calls.json', logs())
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    db.close()
  }
}

main().catch(e => { console.error(e.message); process.exitCode = 1 })
