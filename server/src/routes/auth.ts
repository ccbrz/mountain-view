import { Router } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || 'mountain-view-secret-key'

router.post('/login', async (req, res) => {
  const { username, password } = req.body
  if (!username || !password) {
    return res.status(400).json({ message: '请填写用户名和密码' })
  }

  const db = getDB()
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as {
    id: number; username: string; password_hash: string; role: string
  } | undefined

  if (!user) {
    return res.status(401).json({ message: '用户名或密码错误' })
  }

  const valid = await bcrypt.compare(password, user.password_hash)
  if (!valid) {
    return res.status(401).json({ message: '用户名或密码错误' })
  }

  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  )

  res.json({ token, user: { id: user.id, username: user.username, role: user.role } })
})

router.get('/me', authenticate, (req: AuthRequest, res) => {
  res.json({ user: req.user })
})

router.get('/permissions', authenticate, (req: AuthRequest, res) => {
  if (req.user?.role === 'admin') {
    return res.json({ permissions: ['users:manage', 'roles:manage', 'content:manage', 'settings:manage'] })
  }
  const db = getDB()
  const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(req.user!.role) as { permissions: string } | undefined
  res.json({ permissions: role ? JSON.parse(role.permissions) : [] })
})

export default router
