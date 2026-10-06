import { ProgressState, renderProgress, RECENT_SUMMARIES } from './progress'

/**
 * 故事进度按章存快照：第 N 章的快照 = 进入第 N 章时的进度（第 N-1 章定稿后写入）。
 * 起草、审稿第 N 章只读这一份，重写旧章节时才不会看到本章及之后已经写过的剧情。
 * 快照只存结构化状态，逐章梗概独立存储；给模型和页面看的都是渲染后的文本。
 * 架构和角色档案是静态设定，不存快照。
 */

const DOC = 'progress'

export class ContextConflict extends Error {
  status = 409
}

export function bumpContextRevision(db: any, novelId: number) {
  // ponytail: 整本书共用版本，编辑无关章节也会拒绝旧任务；并发写作频繁时再细分依赖版本。
  db.prepare('UPDATE novels SET context_revision = context_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(novelId)
}

export function assertContextRevision(db: any, novelId: number, expected: number) {
  const row = db.prepare('SELECT context_revision FROM novels WHERE id = ?').get(novelId)
  if (!row || row.context_revision !== expected) {
    throw new ContextConflict('正文、设定或故事进度已变化，本次结果未保存，请重新操作')
  }
}

/** ponytail: 扫描轻量元数据验证连续性；只解析目标快照。章数达到数万再考虑维护有效前缀缓存。 */
function validPrefix(db: any, novelId: number, before?: number): number {
  const rows = db.prepare(`
    SELECT c.chapter_number, c.status, length(trim(c.content)) > 0 AS has_content,
      s.chapter_number IS NOT NULL AS has_snapshot, length(trim(t.content)) > 0 AS has_summary
    FROM novel_chapters c LEFT JOIN novel_doc_snapshots s
      ON s.novel_id = c.novel_id AND s.chapter_number = c.chapter_number + 1 AND s.doc_type = 'progress'
    LEFT JOIN novel_chapter_summaries t ON t.novel_id = c.novel_id AND t.chapter_number = c.chapter_number
    WHERE c.novel_id = ? ${before === undefined ? '' : 'AND c.chapter_number < ?'} ORDER BY c.chapter_number
  `).all(...(before === undefined ? [novelId] : [novelId, before]))
  let next = 1
  for (const row of rows) {
    if (row.chapter_number !== next || row.status !== 'finalized' || !row.has_content || !row.has_snapshot || !row.has_summary) break
    next++
  }
  return next
}

export function requireProgressBeforeChapter(db: any, novelId: number, chapterNum: number): ProgressState | null {
  if (!Number.isSafeInteger(chapterNum) || chapterNum < 1) throw new ContextConflict('章节号必须是正整数')
  if (chapterNum === 1) return null
  const next = validPrefix(db, novelId, chapterNum)
  if (next !== chapterNum) {
    throw new ContextConflict(`前置进度缺失或已失效，请先补齐并定稿第 ${next} 章，再处理第 ${chapterNum} 章`)
  }
  const state = stateBeforeChapter(db, novelId, chapterNum)
  if (!state || state.chapter !== chapterNum - 1) {
    throw new ContextConflict(`进度快照无效，请重新定稿第 ${chapterNum - 1} 章`)
  }
  return state
}

/** 调用方与正文/设定的写入放在同一个事务里；保留正文，只清除派生数据。 */
export function invalidateFromChapter(db: any, novelId: number, chapterNum: number, reviewCurrent = false) {
  bumpContextRevision(db, novelId)
  db.prepare('DELETE FROM novel_doc_snapshots WHERE novel_id = ? AND chapter_number > ?').run(novelId, chapterNum)
  db.prepare('DELETE FROM novel_chapter_summaries WHERE novel_id = ? AND chapter_number >= ?').run(novelId, chapterNum)
  db.prepare(`DELETE FROM vector_embeddings WHERE novel_id = ?
    AND (json_extract(metadata_json, '$.chapter') >= ? OR json_extract(metadata_json, '$.chapter') IS NULL)`)
    .run(novelId, chapterNum)
  db.prepare(`UPDATE novel_chapters SET status = CASE
      WHEN chapter_number = ? AND ? = 0 THEN 'draft'
      WHEN length(trim(content)) > 0 THEN 'needs_review' ELSE 'draft' END,
      index_status = 'pending', updated_at = CURRENT_TIMESTAMP
    WHERE novel_id = ? AND chapter_number >= ?`).run(chapterNum, Number(reviewCurrent), novelId, chapterNum)
  // 最新进度按需从有效快照渲染，不再维护另一份包含全部摘要的文本。
  db.prepare("DELETE FROM novel_docs WHERE novel_id = ? AND doc_type = 'progress'").run(novelId)
}

/** 摘要每章只存一次，快照只保存当时的事实、伏笔和衔接状态。 */
export function saveProgressSnapshot(db: any, novelId: number, chapterNum: number, state: ProgressState) {
  const { summaries, ...snapshot } = state
  const summary = summaries.find(s => s.chapter === state.chapter)
  if (state.chapter !== chapterNum - 1 || !summary?.text.trim()) throw new Error('快照与章节摘要不匹配')
  db.transaction(() => {
    db.prepare(`INSERT INTO novel_chapter_summaries (novel_id, chapter_number, content) VALUES (?, ?, ?)
      ON CONFLICT(novel_id, chapter_number) DO UPDATE SET content = excluded.content`)
      .run(novelId, state.chapter, summary.text)
    db.prepare(`INSERT INTO novel_doc_snapshots (novel_id, chapter_number, doc_type, content) VALUES (?, ?, ?, ?)
      ON CONFLICT(novel_id, chapter_number, doc_type) DO UPDATE SET content = excluded.content`)
      .run(novelId, chapterNum, DOC, JSON.stringify(snapshot))
  })()
}

function readSummaries(db: any, novelId: number, before: number, recent?: number): ProgressState['summaries'] {
  const rows = db.prepare(`SELECT chapter_number AS chapter, content AS text FROM novel_chapter_summaries
    WHERE novel_id = ? AND chapter_number < ? ORDER BY chapter_number DESC ${recent ? 'LIMIT ?' : ''}`)
    .all(...(recent ? [novelId, before, recent] : [novelId, before]))
  return rows.reverse()
}

/** 运行时仅加载最近几章梗概；历史摘要留在独立表中。 */
export function stateBeforeChapter(db: any, novelId: number, chapterNum: number): ProgressState | null {
  const row = db.prepare(
    'SELECT content FROM novel_doc_snapshots WHERE novel_id = ? AND chapter_number = ? AND doc_type = ?'
  ).get(novelId, chapterNum, DOC) as any
  if (!row) return null
  try {
    return { ...JSON.parse(row.content), summaries: readSummaries(db, novelId, chapterNum, RECENT_SUMMARIES) }
  } catch {
    throw new ContextConflict(`进度快照无效，请重新定稿第 ${chapterNum - 1} 章`)
  }
}

/** 进入第 n 章时的进度文本，起草、审稿用（只带最近几章梗概） */
export function progressBeforeChapter(db: any, novelId: number, chapterNum: number): string {
  const s = requireProgressBeforeChapter(db, novelId, chapterNum)
  return s ? renderProgress(s, RECENT_SUMMARIES) : ''
}

/** 下拉列表只返回章节号，选择后才加载内容。 */
export function listProgressSnapshots(db: any, novelId: number): { chapter_number: number }[] {
  return db.prepare(
    'SELECT chapter_number FROM novel_doc_snapshots WHERE novel_id = ? AND doc_type = ? ORDER BY chapter_number'
  ).all(novelId, DOC)
}

/** 页面显式查看某一份进度时，才加载截至该章的全部摘要。 */
export function getProgressSnapshot(db: any, novelId: number, chapterNum = validPrefix(db, novelId)) {
  const state = requireProgressBeforeChapter(db, novelId, chapterNum)
  if (!state) return { chapter_number: chapterNum, content: '' }
  state.summaries = readSummaries(db, novelId, chapterNum)
  return { chapter_number: chapterNum, content: renderProgress(state) }
}
