import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

const JWT_SECRET = process.env.JWT_SECRET || 'mountain-view-secret-key'

export interface AuthRequest extends Request {
  user?: { id: number; username: string; role: string }
}

export function authenticate(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: '未登录' })
  }

  try {
    const token = header.slice(7)
    const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string; role: string }
    req.user = decoded
    next()
  } catch {
    return res.status(401).json({ message: 'Token 无效' })
  }
}

export function requirePermission(...permissions: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ message: '未登录' })

    if (req.user.role === 'admin') return next()

    const { getDB } = require('../db')
    const db = getDB()
    const role = db.prepare('SELECT permissions FROM roles WHERE name = ?').get(req.user.role) as { permissions: string } | undefined

    if (!role) return res.status(403).json({ message: '角色不存在' })

    const userPerms: string[] = JSON.parse(role.permissions)
    const hasAll = permissions.every((p) => userPerms.includes(p))

    if (!hasAll) return res.status(403).json({ message: '无权限' })

    next()
  }
}
