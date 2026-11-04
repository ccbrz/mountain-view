import { AuthRequest } from '../middleware/auth'
import { invalidateFromChapter } from '../llm/revision'

/** Only the creator or an admin can see or change a novel; others get the same response as a missing one. */
export function getNovelOrForbid(db: any, id: string, req: AuthRequest) {
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(id) as any
  if (!novel) return null
  if (req.user?.role !== 'admin' && novel.creator_username !== req.user!.username) return null
  return novel
}

/** 调用方负责事务和异步结果的版本检查，所有正文写入共用失效逻辑。 */
export function saveChapterContent(db: any, novelId: number, chapter: any, content: string, note = '') {
  if (content === chapter.content) return
  if (note && chapter.content) {
    db.prepare('INSERT INTO chapter_revisions (chapter_id, content, word_count, note) VALUES (?, ?, ?, ?)').run(
      chapter.id,
      chapter.content,
      chapter.word_count || 0,
      note,
    )
  }
  db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    content,
    content.replace(/\s/g, '').length,
    chapter.id,
  )
  invalidateFromChapter(db, novelId, chapter.chapter_number)
}
