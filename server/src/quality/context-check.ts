/** 离线接口回归：内存数据库、模拟模型，不读取业务数据或调用外部服务。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'

process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'context-regression-only'

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initVectorStore } = await import('../llm/vectorstore')
  const { initLogStore } = await import('../llm/logstore')
  const { getProgressSnapshot, requireProgressBeforeChapter } = await import('../llm/doc-snapshots')
  const { default: generator } = await import('../routes/novel-generator')
  const { default: novels } = await import('../routes/novels')
  const { default: configs } = await import('../routes/llm-configs')
  const db = getDB()
  initSchema(); initVectorStore(); initLogStore()
  db.prepare('INSERT INTO llm_configs (name, base_url, model_name) VALUES (?, ?, ?)').run('mock', 'https://context-test.invalid', 'mock')

  const realFetch = globalThis.fetch
  let chats = 0, embeddings = 0, failEmbeddingAt = 0
  let patchOutput = ''
  let continuityIssues: any[] = []
  let gate: { kind: string; entered: () => void; wait: Promise<void> } | undefined
  function hold(kind: string) {
    let entered!: () => void, release!: () => void
    const reached = new Promise<void>(resolve => { entered = resolve })
    const wait = new Promise<void>(resolve => { release = resolve })
    gate = { kind, entered, wait }
    return { reached, release }
  }
  globalThis.fetch = (async (url: any, options: any) => {
    assert(String(url).startsWith('https://context-test.invalid/'), '不允许外部网络请求')
    const body = JSON.parse(options.body)
    const embedding = String(url).endsWith('/embeddings')
    const progress = !embedding && body.messages[0].content.startsWith('你是小说的连载编辑')
    const kind = embedding ? 'embedding' : progress ? 'progress' : 'draft'
    if (gate?.kind === kind) { const held = gate; gate = undefined; held.entered(); await held.wait }
    if (embedding) {
      embeddings++
      if (embeddings === failEmbeddingAt) return new Response('模拟索引失败', { status: 503 })
      return Response.json({ data: [{ embedding: [1, 0] }] })
    }
    chats++
    const content = /^你是小说(?:连续性[核复]|信息差检查员)/.test(body.messages[0].content) ? JSON.stringify({ issues: continuityIssues }) : progress
      ? JSON.stringify({ summary: body.messages[1].content.split('章：\n').pop(), facts: [], hooks: [], handoff: { scene: '测试场景' } })
      : patchOutput || '<chapter>重新生成的正文</chapter>'
    return Response.json({ choices: [{ message: { content }, finish_reason: 'stop' }] })
  }) as typeof fetch

  const app = express()
  app.use(express.json()); app.use('/novels', novels); app.use('/novels', generator)
  app.use('/llm-configs', configs)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const port = (server.address() as any).port
  const token = jwt.sign({ username: 'audit', role: 'admin' }, process.env.JWT_SECRET!)
  async function request(id: number, method: string, path: string, body?: any, status = 200) {
    const res = await realFetch(`http://127.0.0.1:${port}/novels/${id}${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const result: any = await res.json()
    assert.equal(res.status, status, `${method} ${path}: ${JSON.stringify(result)}`)
    return result
  }
  const rows = (id: number) => db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number').all(id) as any[]
  const snapshots = (id: number) => db.prepare('SELECT * FROM novel_doc_snapshots WHERE novel_id = ? ORDER BY chapter_number').all(id) as any[]
  const vectors = (id: number) => db.prepare('SELECT * FROM vector_embeddings WHERE novel_id = ? ORDER BY id').all(id) as any[]
  const revision = (id: number) => (db.prepare('SELECT context_revision FROM novels WHERE id = ?').get(id) as any).context_revision
  const progress = (id: number) => getProgressSnapshot(db, id).content
  const finalize = (id: number, n: number, status = 200) => request(id, 'POST', `/generate/finalize/${n}`, {}, status)
  const edit = (id: number, n: number, content: string) => request(id, 'PUT', `/chapters/${n}`, { content })
  async function seed(count = 3, finalized = true, content?: string) {
    const id = Number(db.prepare('INSERT INTO novels (title, creator_username, llm_config, embedding_config) VALUES (?, ?, ?, ?)')
      .run('回归小说', 'audit', 'mock', 'mock').lastInsertRowid)
    for (let n = 1; n <= count; n++) await request(id, 'POST', '/chapters', { chapter_number: n, content: content || `第${n}章原始正文` })
    if (finalized) for (let n = 1; n <= count; n++) await finalize(id, n)
    return id
  }
  function invalidated(id: number, from: number) {
    assert(snapshots(id).every(s => s.chapter_number <= from))
    const summaryRows = db.prepare('SELECT chapter_number FROM novel_chapter_summaries WHERE novel_id = ?').all(id) as any[]
    assert(summaryRows.every(s => s.chapter_number < from))
    assert(vectors(id).every(v => JSON.parse(v.metadata_json).chapter < from))
    assert(rows(id).filter(c => c.chapter_number >= from).every(c => c.status !== 'finalized' && c.index_status === 'pending'))
  }
  async function check(name: string, run: () => Promise<void>) { await run(); console.log(`✓ ${name}`) }

  try {
    await check('改旧章使后续失效，正文保留、最新进度回到有效前缀，顺序定稿后恢复', async () => {
      const id = await seed()
      const before = rows(id), version = revision(id)
      await edit(id, 2, before[1].content) // 同内容保存不应破坏有效快照
      assert.equal(revision(id), version)
      await edit(id, 2, '第二章新正文')
      invalidated(id, 2)
      assert.equal(rows(id)[2].status, 'needs_review')
      assert.equal(rows(id)[2].content, before[2].content)
      assert.match(progress(id), /第1章/); assert.doesNotMatch(progress(id), /第2章/)
      const blocked = await finalize(id, 3, 409); assert.match(blocked.message, /第 2 章/)
      await finalize(id, 2)
      assert.deepEqual(snapshots(id).map(s => s.chapter_number), [2, 3])
      assert.equal(rows(id)[2].status, 'needs_review')
      await finalize(id, 3)
      assert(rows(id).every(c => c.status === 'finalized'))
      await finalize(id, 1)
      assert.deepEqual(snapshots(id).map(s => s.chapter_number), [2])
      assert(rows(id).slice(1).every(c => c.status === 'needs_review'))
    })

    await check('重写、补丁修订、回退、清空正文都走统一失效逻辑', async () => {
      for (const action of ['draft', 'patch', 'revert', 'empty']) {
        const id = await seed(2), first = rows(id)[0]
        if (action === 'draft') await request(id, 'POST', '/generate/chapter/1')
        if (action === 'patch') {
          patchOutput = JSON.stringify([{ note: '改动', find: first.content, replace: '补丁后的正文' }])
          await request(id, 'POST', '/revise/1', { accepted_notes: ['改动'] }); patchOutput = ''
        }
        if (action === 'revert') {
          const r = db.prepare('INSERT INTO chapter_revisions (chapter_id, content) VALUES (?, ?)').run(first.id, '历史版本')
          await request(id, 'POST', `/chapters/1/revisions/${r.lastInsertRowid}/revert`)
          assert.equal(rows(id)[0].content, '历史版本')
        }
        if (action === 'empty') { await edit(id, 1, ''); assert.equal(rows(id)[0].word_count, 0) }
        invalidated(id, 1); assert.equal(progress(id), '')
      }
    })

    await check('删除章节保留缺口，补章后可恢复；缺前情的起草、审稿、定稿均被阻止', async () => {
      const id = await seed()
      await request(id, 'DELETE', `/chapters/${rows(id)[1].id}`)
      invalidated(id, 2)
      const calls = chats
      for (const path of ['/generate/chapter/3', '/review/3', '/generate/finalize/3']) {
        const result = await request(id, 'POST', path, {}, 409); assert.match(result.message, /第 2 章/)
      }
      assert.equal(chats, calls)
      await request(id, 'POST', '/chapters', { chapter_number: 2, content: '补回第二章' })
      await finalize(id, 2); await finalize(id, 3)
      const other = await seed(2, false)
      await finalize(other, 2, 409)
      await request(other, 'POST', '/generate/chapter/0', {}, 400)
      await request(other, 'POST', '/generate/chapter/2oops', {}, 400)
      await request(other, 'POST', '/chapters', { chapter_number: 1.5 }, 400)
    })

    await check('设定变更清理全部派生上下文，文风变更不失效，进度禁止直接写入', async () => {
      for (const path of ['/docs/architecture', '/docs/characters', '/generate/architecture']) {
        const id = await seed(2), contents = rows(id).map(c => c.content)
        await request(id, 'PUT', '', { style_guide: '新文风' })
        assert(rows(id).every(c => c.status === 'finalized'))
        await request(id, path.startsWith('/docs') ? 'PUT' : 'POST', path, { content: '新设定' })
        invalidated(id, 1); assert.equal(progress(id), '')
        assert.deepEqual(rows(id).map(c => c.content), contents)
        assert(rows(id).every(c => c.status === 'needs_review'))
        await request(id, 'PUT', '/docs/progress', { content: '伪造进度' }, 400)
      }
    })

    await check('前章标记定稿但快照缺失、错章或缺历史时，同样拒绝使用', async () => {
      for (const corruption of ['missing', 'wrong-chapter', 'missing-summary']) {
        const id = await seed(2)
        if (corruption === 'missing') db.prepare('DELETE FROM novel_doc_snapshots WHERE novel_id = ? AND chapter_number = 2').run(id)
        else if (corruption === 'missing-summary') db.prepare('DELETE FROM novel_chapter_summaries WHERE novel_id = ? AND chapter_number = 1').run(id)
        else {
          const state = JSON.parse(snapshots(id)[1].content)
          state.chapter = 1
          db.prepare('UPDATE novel_doc_snapshots SET content = ? WHERE novel_id = ? AND chapter_number = 3').run(JSON.stringify(state), id)
        }
        const calls = chats
        await request(id, 'POST', '/generate/chapter/3', {}, 409)
        assert.equal(chats, calls)
        assert.equal(rows(id).length, 2) // 失败的起草不能留下半成品章节
      }
    })

    await check('目录不含正文或快照内容，详情按章读取，运行时仍只加载近期摘要', async () => {
      const id = await seed(5)
      const chapters = await request(id, 'GET', '/chapters')
      assert.equal(chapters.length, 5)
      assert(chapters.every((c: any) => !('content' in c) && !('outline' in c)))
      const detail = await request(id, 'GET', '/chapters/4')
      assert.equal(detail.content, '第4章原始正文')
      const list = await request(id, 'GET', '/progress-snapshots')
      assert.deepEqual(list, [2, 3, 4, 5, 6].map(chapter_number => ({ chapter_number })))
      assert(snapshots(id).every(s => !('summaries' in JSON.parse(s.content))))
      assert.deepEqual(requireProgressBeforeChapter(db, id, 6)?.summaries.map(s => s.chapter), [3, 4, 5])
      const old = await request(id, 'GET', '/progress-snapshots/3')
      assert.match(old.content, /第2章原始正文/); assert.doesNotMatch(old.content, /第3章原始正文/)
      const latest = await request(id, 'GET', '/progress-snapshots/latest')
      assert.match(latest.content, /第1章原始正文/); assert.match(latest.content, /第5章原始正文/)
      const docs = await request(id, 'GET', '/docs')
      assert(!('progress' in docs))
      const exported = await request(id, 'GET', '/export')
      assert.deepEqual(exported.map((c: any) => c.content), rows(id).map(c => c.content))
      await edit(id, 3, '修改第三章')
      await request(id, 'GET', '/progress-snapshots/6', undefined, 409)
      assert.equal((await request(id, 'GET', '/progress-snapshots/latest')).chapter_number, 3)
    })

    await check('定稿期间改正文或设定，旧模型结果返回 409 且不落库', async () => {
      for (const setting of [false, true]) {
        const id = await seed(1, false), held = hold('progress')
        const pending = finalize(id, 1, 409)
        await held.reached
        if (setting) await request(id, 'PUT', '/docs/characters', { content: '新角色设定' })
        else await edit(id, 1, '定稿期间保存的新正文')
        held.release(); await pending
        invalidated(id, 1); assert.equal(progress(id), '')
        if (!setting) assert.equal(rows(id)[0].content, '定稿期间保存的新正文')
      }
    })

    await check('并发定稿只接受一个结果；延迟返回的重写不会覆盖手动编辑', async () => {
      const id = await seed(1, false), held = hold('progress')
      const pending = finalize(id, 1, 409)
      await held.reached; await finalize(id, 1); held.release(); await pending
      assert.equal(snapshots(id).length, 1)
      const draft = hold('draft'), rewriting = request(id, 'POST', '/generate/chapter/1', {}, 409)
      await draft.reached; await edit(id, 1, '作者刚保存的正文'); draft.release(); await rewriting
      assert.equal(rows(id)[0].content, '作者刚保存的正文'); invalidated(id, 1)
    })

    await check('索引失败无半成品，独立重试不调用进度模型，替换失败保留完整旧索引', async () => {
      const id = await seed(1, false, '长'.repeat(1100))
      failEmbeddingAt = embeddings + 2
      const result = await finalize(id, 1)
      assert.match(result.warning, /索引待更新/)
      assert.equal(rows(id)[0].status, 'finalized'); assert.equal(rows(id)[0].index_status, 'pending')
      assert.equal(snapshots(id).length, 1); assert.equal(vectors(id).length, 0)
      const calls = chats, version = revision(id)
      await request(id, 'POST', '/chapters/1/reindex')
      assert.equal(chats, calls); assert.equal(revision(id), version)
      assert.equal(rows(id)[0].index_status, 'ready'); assert.equal(vectors(id).length, 3)
      const before = vectors(id)
      failEmbeddingAt = embeddings + 2
      await request(id, 'POST', '/chapters/1/reindex', {}, 500)
      assert.deepEqual(vectors(id), before)
      const held = hold('embedding'), pending = request(id, 'POST', '/chapters/1/reindex', {}, 409)
      await held.reached; await edit(id, 1, '索引期间改稿'); held.release(); await pending
      invalidated(id, 1)
    })

    await check('审校疑点保留待审草稿及旧稿存档，不写入记忆或索引', async () => {
      const id = await seed(1, false), original = rows(id)[0].content
      continuityIssues = [{ problem: '待作者核对的模型意见', candidate_id: 'C1', evidence_id: 'S1' }]
      try {
        const result = await request(id, 'POST', '/generate/chapter/1')
        assert.match(result.warning, /草稿待核对/)
        assert.equal(rows(id)[0].status, 'draft')
        assert.equal(snapshots(id).length, 0); assert.equal(vectors(id).length, 0)
        assert.equal((db.prepare('SELECT content FROM chapter_revisions WHERE chapter_id=? ORDER BY id DESC LIMIT 1').get(rows(id)[0].id) as any).content, original)
      } finally { continuityIssues = [] }
    })

    await check('连续性检查阻止错误正文定稿，旧正文和记忆保持原样', async () => {
      const id = await seed(1, false, '同一把钥匙已经沉海。季叔还握着它。')
      const before = { rows: rows(id), snaps: snapshots(id), version: revision(id) }
      continuityIssues = [{ problem: '钥匙状态矛盾', candidate_id: 'C1', evidence_id: 'C1' }]
      try { await finalize(id, 1, 422) } finally { continuityIssues = [] }
      assert.deepEqual({ rows: rows(id), snaps: snapshots(id), version: revision(id) }, before)
    })

    await check('向量预检失败不保存配置、不破坏已有状态', async () => {
      const id = await seed(1)
      await request(id, 'PUT', '', { embedding_config: '' })
      const before = { rows: rows(id), snaps: snapshots(id), version: revision(id) }
      failEmbeddingAt = embeddings + 1
      await request(id, 'PUT', '', { embedding_config: 'mock' }, 400)
      assert.equal((db.prepare('SELECT embedding_config FROM novels WHERE id=?').get(id) as any).embedding_config, '')
      assert.deepEqual({ rows: rows(id), snaps: snapshots(id), version: revision(id) }, before)
    })

    await check('编辑已使用的向量模型也必须预检，失败保留，成功只失效索引', async () => {
      const id = await seed(1)
      const config = db.prepare("SELECT * FROM llm_configs WHERE name='mock'").get() as any
      const before = { vectors: vectors(id), version: revision(id) }
      failEmbeddingAt = embeddings + 1
      const response = await realFetch(`http://127.0.0.1:${port}/llm-configs/${config.id}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: 'not-an-embedding-model' }),
      })
      assert.equal(response.status, 400)
      assert.deepEqual(db.prepare('SELECT * FROM llm_configs WHERE id=?').get(config.id), config)
      assert.deepEqual({ vectors: vectors(id), version: revision(id) }, before)
      const beforeSnapshots = snapshots(id)
      const saved = await realFetch(`http://127.0.0.1:${port}/llm-configs/${config.id}`, {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_name: 'mock-v2' }),
      })
      assert.equal(saved.status, 200)
      assert.equal(vectors(id).length, 0); assert.equal(rows(id)[0].index_status, 'pending')
      assert.equal(rows(id)[0].status, 'finalized'); assert(revision(id) > before.version)
      assert.deepEqual(snapshots(id), beforeSnapshots)
    })

    await check('定稿事务写入失败时，旧进度、下游状态和索引全部回滚', async () => {
      const id = await seed(2), before = { rows: rows(id), snaps: snapshots(id), vectors: vectors(id), progress: progress(id), version: revision(id) }
      db.exec(`CREATE TRIGGER reject_snapshot BEFORE INSERT ON novel_doc_snapshots WHEN NEW.novel_id = ${id} BEGIN SELECT RAISE(ABORT, '模拟快照写入失败'); END`)
      await finalize(id, 1, 500)
      db.exec('DROP TRIGGER reject_snapshot')
      assert.deepEqual({ rows: rows(id), snaps: snapshots(id), vectors: vectors(id), progress: progress(id), version: revision(id) }, before)
    })

    await check('切换 Embedding 配置只使索引失效；删除小说清理向量', async () => {
      const id = await seed(1)
      await request(id, 'PUT', '', { embedding_config: '' })
      assert.equal(rows(id)[0].status, 'finalized'); assert.equal(snapshots(id).length, 1)
      assert.equal(rows(id)[0].index_status, 'pending'); assert.equal(vectors(id).length, 0)
      await request(id, 'PUT', '', { embedding_config: 'mock' })
      await request(id, 'POST', '/chapters/1/reindex')
      await request(id, 'DELETE', '')
      assert.equal(vectors(id).length, 0); assert.equal(snapshots(id).length, 0)
    })

    await check('升级保留正文、废弃无法验证的旧记忆；重复启动不影响已重建进度', async () => {
      const id = await seed(2), contents = rows(id).map(c => c.content)
      initSchema(); initVectorStore()
      assert.equal(snapshots(id).length, 2)
      db.exec('ALTER TABLE novels DROP COLUMN context_revision')
      initSchema(); initVectorStore()
      assert.deepEqual(rows(id).map(c => c.content), contents); invalidated(id, 1)
      await finalize(id, 1); await finalize(id, 2)
      initSchema(); initVectorStore()
      assert.equal(snapshots(id).length, 2); assert(rows(id).every(c => c.status === 'finalized'))
    })
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
    db.close()
  }
}
main().catch(err => { console.error(err); process.exitCode = 1 })
