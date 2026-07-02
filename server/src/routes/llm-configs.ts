import { Router } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'

const router = Router()

router.get('/', authenticate, (_req: AuthRequest, res) => {
  const db = getDB()
  const configs = db.prepare('SELECT * FROM llm_configs ORDER BY name').all()
  res.json(configs)
})

router.post('/', authenticate, (req: AuthRequest, res) => {
  const { name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout } = req.body
  if (!name || !base_url || !model_name) {
    return res.status(400).json({ message: '名称、Base URL、模型名不能为空' })
  }
  const db = getDB()
  const existing = db.prepare('SELECT id FROM llm_configs WHERE name = ?').get(name)
  if (existing) {
    return res.status(400).json({ message: '配置名称已存在' })
  }
  const result = db.prepare(
    'INSERT INTO llm_configs (name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    name,
    interface_format || 'OpenAI',
    base_url,
    model_name,
    api_key || '',
    temperature ?? 0.7,
    max_tokens ?? 4096,
    timeout ?? 600,
    req.user!.username
  )
  res.json({ message: 'ok', id: result.lastInsertRowid })
})

router.put('/:id', authenticate, (req: AuthRequest, res) => {
  const { name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout } = req.body
  const db = getDB()
  const config = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(req.params.id) as any
  if (!config) return res.status(404).json({ message: '配置不存在' })

  const newName = name || config.name
  if (newName !== config.name) {
    const dup = db.prepare('SELECT id FROM llm_configs WHERE name = ? AND id != ?').get(newName, req.params.id)
    if (dup) return res.status(400).json({ message: '配置名称已存在' })
  }

  db.prepare(
    'UPDATE llm_configs SET name = ?, interface_format = ?, base_url = ?, model_name = ?, api_key = ?, temperature = ?, max_tokens = ?, timeout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
  ).run(
    newName,
    interface_format ?? config.interface_format,
    base_url ?? config.base_url,
    model_name ?? config.model_name,
    api_key !== undefined ? api_key : config.api_key,
    temperature ?? config.temperature,
    max_tokens ?? config.max_tokens,
    timeout ?? config.timeout,
    req.params.id
  )
  res.json({ message: 'ok' })
})

router.delete('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const config = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(req.params.id)
  if (!config) return res.status(404).json({ message: '配置不存在' })
  db.prepare('DELETE FROM llm_configs WHERE id = ?').run(req.params.id)
  res.json({ message: 'ok' })
})

router.post('/:id/test', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const config = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(req.params.id) as any
  if (!config) return res.status(404).json({ message: '配置不存在' })

  try {
    const url = `${config.base_url.replace(/\/+$/, '')}/chat/completions`
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (config.api_key) headers['Authorization'] = `Bearer ${config.api_key}`

    const body = {
      model: config.model_name,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 10,
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!response.ok) {
      const text = await response.text()
      return res.json({ success: false, message: `API 返回 ${response.status}: ${text.slice(0, 200)}` })
    }

    const data: any = await response.json()
    const content = data.choices?.[0]?.message?.content || ''
    res.json({ success: true, message: `连接成功！模型回复: "${content}"` })
  } catch (err: any) {
    res.json({ success: false, message: `连接失败: ${err.message}` })
  }
})

export default router
