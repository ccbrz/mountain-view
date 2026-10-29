/** Complete Memory versions, tied to the prose they summarized. Never reconstruct from N-chapter deltas. */
import { createHash } from 'node:crypto'

function sources(db: any, novel: number, through: number) {
  return db.prepare('SELECT id,chapter_number,title,content,status FROM novel_chapters WHERE novel_id=? AND chapter_number<=? ORDER BY chapter_number').all(novel, through) as any[]
}
function digest(rows: any[]) {
  return createHash('sha256').update(JSON.stringify(rows.map(r => [r.id, r.chapter_number, r.title, r.content]))).digest('hex')
}
export function recordWriterMemory(db: any, novel: number, memory: string, kind: string, user: string, chapter?: number, title = '', through?: number) {
  const rows = through === undefined ? [] : sources(db, novel, through)
  const complete = through !== undefined && rows.length === through && rows.every((r, i) => r.chapter_number === i + 1 && r.content.trim() && r.status === 'finalized')
  db.prepare('INSERT INTO writer_memory_history(novel_id,chapter_number,title,memory,kind,created_by,memory_through_chapter,source_digest) VALUES (?,?,?,?,?,?,?,?)')
    .run(novel, chapter ?? null, title, memory, kind, user, through ?? null, complete ? digest(rows) : '')
}
export function memoryVersionStatus(db: any, novel: number, version: any) {
  const through = version.memory_through_chapter
  let reason = ''
  if (version.invalidated_at) reason = '对应正文或前置记忆已有更新，此快照仅供历史查看。'
  else if (through === null || through === undefined || !version.source_digest) reason = '旧版本未记录完整的来源校验信息，仅供查看，不能确认适用于当前前文。'
  else {
    const rows = sources(db, novel, through)
    if (rows.length !== through || rows.some((r, i) => r.chapter_number !== i + 1 || !r.content.trim() || r.status !== 'finalized')) reason = '对应前文有缺失或尚未重新定稿，请先处理前面的章节。'
    else if (digest(rows) !== version.source_digest) reason = '对应前文已修改，此快照不再适用。'
  }
  return {...version, restorable: !reason, restore_reason: reason}
}
export function memoryBeforeChapter(db: any, novel: number, chapter: number) {
  const rows = db.prepare('SELECT * FROM writer_memory_history WHERE novel_id=? AND memory_through_chapter=? ORDER BY id DESC').all(novel, chapter - 1)
  for (const row of rows) {
    const version = memoryVersionStatus(db, novel, row)
    if (version.restorable) return version
  }
  // An explicit empty opening is a user choice, never a guessed historical Memory.
  if (chapter === 1) return {id: null, memory: '', memory_through_chapter: 0, restorable: true, restore_reason: '', empty_opening: true}
  return {id: null, restorable: false, restore_reason: rows.length ? '该章开始前的记忆快照已失效或无法核验，请先核对并重新定稿前面的章节。' : `没有第 ${chapter - 1} 章结束时的完整记忆快照，请先核对并定稿该章。`}
}
export function invalidateWriterMemory(db: any, novel: number, from: number) {
  db.prepare("UPDATE writer_memory_history SET invalidated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE novel_id=? AND memory_through_chapter>=? AND invalidated_at=''").run(novel, from)
}
