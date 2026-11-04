import { invalidateWriterMemory } from './writer-memory'

export class ContextConflict extends Error {
  status = 409
}

export function bumpContextRevision(db: any, novelId: number) {
  // ponytail: 整本书共用版本，编辑无关章节也会拒绝旧任务；并发写作频繁时再细分依赖版本。
  db.prepare(
    'UPDATE novels SET context_revision = context_revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(novelId)
}

export function assertContextRevision(db: any, novelId: number, expected: number) {
  const row = db.prepare('SELECT context_revision FROM novels WHERE id = ?').get(novelId)
  if (!row || row.context_revision !== expected) {
    throw new ContextConflict('正文、设定或 Memory 已变化，本次结果未保存，请重新操作')
  }
}

/** 正文变更后：本章回到草稿，后续已写章节待核对，基于这些正文的记忆快照失效。调用方负责事务。 */
export function invalidateFromChapter(db: any, novelId: number, chapterNum: number) {
  invalidateWriterMemory(db, novelId, chapterNum)
  bumpContextRevision(db, novelId)
  db.prepare(
    `UPDATE novel_chapters SET status = CASE
      WHEN chapter_number = ? THEN 'draft'
      WHEN length(trim(content)) > 0 THEN 'needs_review' ELSE 'draft' END,
      updated_at = CURRENT_TIMESTAMP
    WHERE novel_id = ? AND chapter_number >= ?`,
  ).run(chapterNum, novelId, chapterNum)
}
