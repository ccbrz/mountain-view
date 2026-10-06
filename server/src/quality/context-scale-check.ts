/** 500 章离线规模与迁移回归；数值是合成数据的有效载荷，不是 SQLite 文件大小或模型质量。 */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { ProgressState } from '../llm/progress'

process.env.DB_PATH = ':memory:'

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initVectorStore } = await import('../llm/vectorstore')
  const { renderProgress } = await import('../llm/progress')
  const { getProgressSnapshot, requireProgressBeforeChapter, listProgressSnapshots, invalidateFromChapter } = await import('../llm/doc-snapshots')
  initSchema(); initVectorStore()
  const db = getDB()
  const create = () => Number(db.prepare("INSERT INTO novels (title, creator_username) VALUES ('合成规模检查', 'scale')").run().lastInsertRowid)
  const id = create()
  const state: ProgressState = { chapter: 0, summaries: [], facts: [], hooks: [], handoff: { scene: '', doing: '', pending: '', mood: '', lastLines: '' }, nextFact: 1, nextHook: 1 }
  db.transaction(() => {
    // 构造上一版本的真实存储格式：每份快照重复嵌入截至当时的所有摘要。
    for (let n = 1; n <= 500; n++) {
      db.prepare("INSERT INTO novel_chapters (novel_id, chapter_number, content, word_count, status) VALUES (?, ?, ?, 2000, 'finalized')").run(id, n, '文'.repeat(2000))
      state.chapter = n
      state.summaries.push({ chapter: n, text: '梗'.repeat(250) })
      db.prepare("INSERT INTO novel_doc_snapshots VALUES (?, ?, 'progress', ?)").run(id, n + 1, JSON.stringify(state))
    }
    db.exec('DROP TABLE novel_chapter_summaries')
  })()
  const legacyRows = () => db.prepare("SELECT c.chapter_number, c.status, c.content, s.content AS snapshot FROM novel_chapters c LEFT JOIN novel_doc_snapshots s ON s.novel_id = c.novel_id AND s.chapter_number = c.chapter_number + 1 AND s.doc_type = 'progress' WHERE c.novel_id = ? ORDER BY c.chapter_number").all(id) as any[]
  const medianMs = (fn: () => void) => {
    const times = Array.from({ length: 3 }, () => { const start = performance.now(); fn(); return performance.now() - start })
    return +times.sort((a, b) => a - b)[1].toFixed(2)
  }
  const legacyValidationMs = medianMs(() => {
    let next = 1
    for (const row of legacyRows()) {
      const candidate = JSON.parse(row.snapshot)
      assert(row.chapter_number === next && row.status === 'finalized' && row.content.trim())
      assert(candidate.chapter === next && candidate.summaries.length === next && candidate.summaries.every((s: any, i: number) => s.chapter === i + 1))
      next++
    }
    assert.equal(next, 501)
  })
  const beforeBytes = (db.prepare('SELECT sum(length(cast(content AS BLOB))) AS bytes FROM novel_doc_snapshots WHERE novel_id = ?').get(id) as any).bytes
  const beforeListBytes = Buffer.byteLength(JSON.stringify(legacyRows().map(r => ({ chapter_number: r.chapter_number + 1, content: renderProgress(JSON.parse(r.snapshot)) }))))
  const expectedLatest = renderProgress(state)

  // 单独验证事实、伏笔、衔接、计数器在拆分时保持不变。
  const richId = create()
  const rich: ProgressState = {
    chapter: 1, summaries: [{ chapter: 1, text: '第一章重要事件' }],
    facts: [{ id: 'F1', kind: 'item', subject: '钥匙', predicate: '持有人', value: '甲' }],
    hooks: [{ id: 'H1', content: '未揭晓的门后声音', planted: 1, lastAdvanced: null, status: 'open' }],
    handoff: { scene: '门外', doing: '开锁', pending: '敲门声', mood: '紧张', lastLines: '门开了。' }, nextFact: 2, nextHook: 2,
  }
  db.prepare("INSERT INTO novel_chapters (novel_id, chapter_number, content, status) VALUES (?, 1, '原正文', 'finalized')").run(richId)
  db.prepare("INSERT INTO novel_doc_snapshots VALUES (?, 2, 'progress', ?)").run(richId, JSON.stringify(rich))

  const brokenId = create()
  db.prepare("INSERT INTO novel_doc_snapshots VALUES (?, 2, 'progress', ?)").run(brokenId, JSON.stringify({ ...rich, summaries: [] }))
  assert.throws(() => initSchema(), /迁移已回滚/)
  assert(!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'novel_chapter_summaries'").get())
  assert(JSON.parse((db.prepare("SELECT content FROM novel_doc_snapshots WHERE novel_id = ? AND chapter_number = 2").get(id) as any).content).summaries)
  db.prepare('DELETE FROM novel_doc_snapshots WHERE novel_id = ?').run(brokenId)
  db.prepare('DELETE FROM novels WHERE id = ?').run(brokenId)

  initSchema()
  assert.equal(getProgressSnapshot(db, id).content, expectedLatest)
  assert.deepEqual(requireProgressBeforeChapter(db, richId, 2), rich)
  assert.equal((db.prepare('SELECT count(*) AS n FROM novel_chapter_summaries WHERE novel_id = ?').get(id) as any).n, 500)
  assert.deepEqual(requireProgressBeforeChapter(db, id, 501)?.summaries.map(s => s.chapter), [498, 499, 500])
  assert.deepEqual(requireProgressBeforeChapter(db, id, 250)?.summaries.map(s => s.chapter), [247, 248, 249])
  assert.equal((db.prepare("SELECT count(*) AS n FROM novel_chapters WHERE novel_id = ? AND status = 'finalized'").get(id) as any).n, 500)
  initSchema() // 二次启动不重复迁移，也不丢状态
  assert.equal(getProgressSnapshot(db, id).content, expectedLatest)

  const afterBytes = (db.prepare(`SELECT
    (SELECT sum(length(cast(content AS BLOB))) FROM novel_doc_snapshots WHERE novel_id = ?) +
    (SELECT sum(length(cast(content AS BLOB))) FROM novel_chapter_summaries WHERE novel_id = ?) AS bytes`).get(id, id) as any).bytes
  const afterListBytes = Buffer.byteLength(JSON.stringify(listProgressSnapshots(db, id)))
  const newValidationMs = medianMs(() => { assert.equal(requireProgressBeforeChapter(db, id, 501)?.chapter, 500) })
  assert(afterBytes < beforeBytes / 100, '摘要和快照的有效载荷应至少减少 99%')
  assert(afterListBytes < 15000, '500 章快照目录不应携带内容')

  db.transaction(() => invalidateFromChapter(db, id, 250))()
  assert.equal((db.prepare('SELECT count(*) AS n FROM novel_chapter_summaries WHERE novel_id = ?').get(id) as any).n, 249)
  assert.equal(requireProgressBeforeChapter(db, id, 250)?.chapter, 249)
  assert.throws(() => requireProgressBeforeChapter(db, id, 251), /第 250 章/)
  assert.equal(getProgressSnapshot(db, id).chapter_number, 250)

  console.log('✓ 500 章无损迁移、失败回滚、重复启动、近期摘要和旧章失效回归通过')
  console.log(JSON.stringify({ chapters: 500, bodyCharacters: 1000000, summaryCharacters: 250,
    before: { snapshotBytes: beforeBytes, snapshotListBytes: beforeListBytes, validationMedianMs: legacyValidationMs },
    after: { snapshotAndSummaryBytes: afterBytes, snapshotListBytes: afterListBytes, validationMedianMs: newValidationMs },
  }, null, 2))
  db.close()
}
main().catch(err => { console.error(err); process.exitCode = 1 })
