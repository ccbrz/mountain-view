import { getDB } from '../db'
import { bumpContextRevision } from './doc-snapshots'
import { parseLooseJSON } from './json-repair'

export function validateOutline(outline: unknown): asserts outline is string {
  if (typeof outline !== 'string' || !outline.trim() || outline.length > 50000) throw new Error('台本需为非空文本，最多 50000 字')
}

export function parseOutlineCandidate(text: string) {
  const data = parseLooseJSON(text)
  validateOutline(data?.outline)
  if (!Array.isArray(data.suggestions) || data.suggestions.length > 20 || data.suggestions.some((s: any) =>
    !s || typeof s.text !== 'string' || !s.text.trim() || s.text.length > 2000 || typeof s.reason !== 'string' || s.reason.length > 2000)) throw new Error('AI 补充建议格式错误，原台本和已有候选已保留')
  if (!Array.isArray(data.notes) || data.notes.length > 20 || data.notes.some((n: any) => typeof n !== 'string' || n.length > 3000)) throw new Error('AI 核对意见格式错误，原台本和已有候选已保留')
  return { outline: data.outline as string, suggestions: data.suggestions as {text: string; reason: string}[], notes: data.notes as string[], selected: [] as number[] }
}

/** 调用方负责事务和版本核对；手工编辑、采纳、恢复共用同一版本递增路径。 */
export function writeOutline(chapter: any, outline: string, archive?: {user: string; note: string}) {
  const db = getDB()
  if (outline === chapter.outline) return
  if (archive) db.prepare('INSERT INTO chapter_outline_revisions(chapter_id,outline,note,created_by) VALUES (?,?,?,?)')
    .run(chapter.id, chapter.outline || '', archive.note, archive.user)
  db.prepare('UPDATE novel_chapters SET outline=?,outline_revision=outline_revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(outline,chapter.id)
  bumpContextRevision(db,chapter.novel_id)
}
