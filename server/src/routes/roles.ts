import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { getDB } from '../db'
import { authenticate, requirePermission } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, requirePermission('roles:manage'), (_req, res) => {
  const db = getDB()
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all() as any[]
  res.json(roles.map((r) => ({ ...r, permissions: JSON.parse(r.permissions) })))
})

router.post('/', authenticate, requirePermission('roles:manage'), (req, res) => {
  const { name, description, permissions } = req.body
  const db = getDB()
  db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
    name, description || '', JSON.stringify(permissions || [])
  )
  res.json({ message: 'ok' })
})

router.put('/:id', authenticate, requirePermission('roles:manage'), (req, res) => {
  const { description, permissions } = req.body
  const db = getDB()
  db.prepare('UPDATE roles SET description = ?, permissions = ? WHERE id = ?').run(
    description || '', JSON.stringify(permissions || []), req.params.id
  )
  res.json({ message: 'ok' })
})

router.delete('/:id', authenticate, requirePermission('roles:manage'), (req, res) => {
  const db = getDB()
  db.prepare('DELETE FROM roles WHERE id = ?').run(req.params.id)
  res.json({ message: 'ok' })
})

router.get('/users', authenticate, requirePermission('roles:manage'), (_req, res) => {
  const db = getDB()
  const users = db.prepare('SELECT id, username, role FROM users ORDER BY id').all()
  res.json(users)
})

router.put('/users/:id/role', authenticate, requirePermission('roles:manage'), (req, res) => {
  const { role } = req.body
  const db = getDB()
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id)
  res.json({ message: 'ok' })
})

router.post('/users', authenticate, requirePermission('roles:manage'), async (req, res) => {
  const { username, password, role } = req.body
  if (!username || !password) {
    return res.status(400).json({ message: '请填写用户名和密码' })
  }
  const db = getDB()
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (existing) {
    return res.status(400).json({ message: '用户名已存在' })
  }
  const hash = await bcrypt.hash(password, 10)
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, hash, role || 'user')
  res.json({ message: 'ok' })
})

export default router
