import { Router } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { bumpContextRevision } from '../llm/revision'
import { clearLogsByNovelId } from '../llm/logstore'
import { getNovelOrForbid } from './shared'

const router = Router()

const NOVEL_COLUMNS = `n.id, n.title, n.creator_username, n.genre, n.word_number, n.guidance, n.style_guide, n.created_at, n.updated_at,
  (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id) AS chapter_count,
  (SELECT COALESCE(SUM(c.word_count), 0) FROM novel_chapters c WHERE c.novel_id = n.id) AS word_count,
  (SELECT COUNT(*) FROM novel_chapters c WHERE c.novel_id = n.id AND c.status = 'finalized') AS finalized_count`

function validate(body: any, partial: boolean) {
  const { title, genre, word_number, guidance } = body || {}
  if (!partial || title !== undefined) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) return '请输入 200 字以内的小说标题'
  }
  if (genre !== undefined && (typeof genre !== 'string' || genre.length > 100)) return '类型最多 100 字'
  if (word_number !== undefined && (!Number.isSafeInteger(word_number) || word_number < 100 || word_number > 50000))
    return '每章目标字数范围 100–50000'
  if (guidance !== undefined && (typeof guidance !== 'string' || guidance.length > 20000))
    return '写作指引最多 20000 字'
  return ''
}

router.get('/', authenticate, (req: AuthRequest, res) => {
  const { search } = req.query
  const conditions: string[] = [],
    params: any[] = []
  if (req.user?.role !== 'admin') {
    conditions.push('n.creator_username = ?')
    params.push(req.user!.username)
  }
  if (typeof search === 'string' && search) {
    conditions.push('n.title LIKE ?')
    params.push(`%${search}%`)
  }
  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
  res.json(
    getDB()
      .prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n${where} ORDER BY n.updated_at DESC`)
      .all(...params),
  )
})

router.get('/:id', authenticate, (req: AuthRequest, res) => {
  if (!getNovelOrForbid(getDB(), req.params.id, req)) return res.status(404).json({ message: '小说不存在或无权限' })
  res.json(getDB().prepare(`SELECT ${NOVEL_COLUMNS} FROM novels n WHERE n.id = ?`).get(req.params.id))
})

router.post('/', authenticate, (req: AuthRequest, res) => {
  const error = validate(req.body, false)
  if (error) return res.status(400).json({ message: error })
  const { title, genre, word_number, guidance } = req.body
  const result = getDB()
    .prepare('INSERT INTO novels (title, creator_username, genre, word_number, guidance) VALUES (?, ?, ?, ?, ?)')
    .run(title.trim(), req.user!.username, genre || '', word_number || 2000, guidance || '')
  res.json({ message: 'ok', id: result.lastInsertRowid })
})

router.put('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB(),
    novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const error = validate(req.body, true)
  if (error) return res.status(400).json({ message: error })
  const { title, genre, word_number, guidance } = req.body
  db.transaction(() => {
    db.prepare(
      'UPDATE novels SET title = ?, genre = ?, word_number = ?, guidance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    ).run(
      title?.trim() ?? novel.title,
      genre ?? novel.genre,
      word_number ?? novel.word_number,
      guidance ?? novel.guidance,
      novel.id,
    )
    // 这些字段会进入写作上下文，变化后旧的生成和核对结果不能再采用。
    if (
      [
        ['title', title],
        ['genre', genre],
        ['word_number', word_number],
        ['guidance', guidance],
      ].some(([k, v]) => v !== undefined && v !== novel[k])
    )
      bumpContextRevision(db, novel.id)
  })()
  res.json({ message: 'ok' })
})

router.delete('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB(),
    novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  db.transaction(() => {
    db.prepare('DELETE FROM novel_chapters WHERE novel_id = ?').run(novel.id)
    db.prepare('DELETE FROM novel_docs WHERE novel_id = ?').run(novel.id)
    db.prepare('DELETE FROM novels WHERE id = ?').run(novel.id)
  })()
  clearLogsByNovelId(novel.id)
  res.json({ message: 'ok' })
})

export default router
