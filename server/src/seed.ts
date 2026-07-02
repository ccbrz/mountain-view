import bcrypt from 'bcryptjs'
import { getDB } from './db'
import { initSchema } from './schema'

async function seed() {
  initSchema()
  const db = getDB()

  const existing = db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }
  if (existing.count > 0) {
    console.log('数据库已初始化，跳过 seeding。')
    process.exit(0)
  }

  const hash = await bcrypt.hash('950711', 10)

  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run('admin', hash, 'admin')

  db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
    'admin', '管理员', JSON.stringify(['users:manage', 'roles:manage', 'content:manage', 'settings:manage'])
  )
  db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
    'editor', '编辑者', JSON.stringify(['content:manage'])
  )
  db.prepare('INSERT INTO roles (name, description, permissions) VALUES (?, ?, ?)').run(
    'user', '普通用户', JSON.stringify([])
  )

  console.log('种子数据创建成功！')
  console.log('默认账号: admin / 950711')
  process.exit(0)
}

seed()
