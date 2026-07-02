import { Router } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, (req: AuthRequest, res) => {
  const { search } = req.query
  const db = getDB()
  const isAdmin = req.user?.role === 'admin'

  const conditions: string[] = []
  const params: any[] = []

  if (!isAdmin) {
    conditions.push('creator_username = ?')
    params.push(req.user!.username)
  }

  if (search) {
    conditions.push('title LIKE ?')
    params.push(`%${search}%`)
  }

  let sql = 'SELECT * FROM novels'
  if (conditions.length > 0) sql += ' WHERE ' + conditions.join(' AND ')
  sql += ' ORDER BY updated_at DESC'

  const novels = db.prepare(sql).all(...params)
  res.json(novels)
})

router.get('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(req.params.id) as any
  if (!novel) return res.status(404).json({ message: '小说不存在' })

  const isAdmin = req.user?.role === 'admin'
  const isCreator = novel.creator_username === req.user!.username
  if (!isAdmin && !isCreator) return res.status(403).json({ message: '无权限' })

  // also fetch docs and chapters count
  const docs = db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(req.params.id) as any[]
  const chapterCount = db.prepare('SELECT COUNT(*) as count FROM novel_chapters WHERE novel_id = ?').get(req.params.id) as { count: number }

  const docMap: Record<string, string> = {}
  for (const d of docs) docMap[d.doc_type] = d.content

  res.json({
    ...novel,
    docs: docMap,
    generated_chapters: chapterCount.count,
  })
})

router.post('/', authenticate, (req: AuthRequest, res) => {
  const { title, content, genre, num_chapters, word_number, guidance } = req.body
  if (!title) return res.status(400).json({ message: '请输入小说标题' })

  const db = getDB()
  const result = db.prepare(
    'INSERT INTO novels (title, content, creator_username, genre, num_chapters, word_number, guidance) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(title, content || '', req.user!.username, genre || '', num_chapters || 10, word_number || 2000, guidance || '')
  res.json({ message: 'ok', id: result.lastInsertRowid })
})

router.put('/:id', authenticate, (req: AuthRequest, res) => {
  const { title, content, genre, num_chapters, word_number, guidance, status, llm_config, embedding_config, style_reference, style_guide } = req.body
  const db = getDB()
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(req.params.id) as any

  if (!novel) return res.status(404).json({ message: '小说不存在' })

  const isAdmin = req.user?.role === 'admin'
  const isCreator = novel.creator_username === req.user!.username
  if (!isAdmin && !isCreator) return res.status(403).json({ message: '无权限编辑此小说' })

  db.prepare(
    `UPDATE novels SET
      title = ?, content = ?, genre = ?, num_chapters = ?, word_number = ?,
      guidance = ?, status = ?, llm_config = ?, embedding_config = ?, 
      style_reference = ?, style_guide = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    title ?? novel.title,
    content ?? novel.content,
    genre ?? novel.genre,
    num_chapters ?? novel.num_chapters,
    word_number ?? novel.word_number,
    guidance ?? novel.guidance,
    status ?? novel.status,
    llm_config ?? novel.llm_config,
    embedding_config ?? novel.embedding_config,
    style_reference ?? novel.style_reference,
    style_guide ?? novel.style_guide,
    req.params.id,
  )
  res.json({ message: 'ok' })
})

router.delete('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(req.params.id) as any
  if (!novel) return res.status(404).json({ message: '小说不存在' })

  const isAdmin = req.user?.role === 'admin'
  const isCreator = novel.creator_username === req.user!.username
  if (!isAdmin && !isCreator) return res.status(403).json({ message: '无权限删除此小说' })

  db.prepare('DELETE FROM novel_chapters WHERE novel_id = ?').run(req.params.id)
  db.prepare('DELETE FROM novel_docs WHERE novel_id = ?').run(req.params.id)
  db.prepare('DELETE FROM novels WHERE id = ?').run(req.params.id)
  res.json({ message: 'ok' })
})

export default router
