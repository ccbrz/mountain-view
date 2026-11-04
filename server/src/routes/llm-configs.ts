import { Router, Response } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { invokeLLM } from '../llm/adapter'
import { redactKey } from '../llm/config'
import { checkImageAccount, isImageModel } from '../llm/lore-portrait'

const router = Router()

// api_key 一律不出库：只暴露 has_key 供前端判断是否已配置
const CONFIG_COLUMNS =
  "id, name, interface_format, base_url, model_name, temperature, max_tokens, timeout, created_by, created_at, updated_at, (api_key != '') AS has_key"

/** 修改、删除、测试会使用或改变已存的 Key，只允许创建者和管理员操作。 */
function ownConfig(req: AuthRequest, res: Response) {
  const config = getDB().prepare('SELECT * FROM llm_configs WHERE id = ?').get(req.params.id) as any
  if (!config) return void res.status(404).json({ message: '配置不存在' })
  if (req.user!.role !== 'admin' && config.created_by !== req.user!.username)
    return void res.status(403).json({ message: '只能管理自己创建的模型配置' })
  return config
}

router.get('/', authenticate, (_req: AuthRequest, res) => {
  const db = getDB()
  const configs = db.prepare(`SELECT ${CONFIG_COLUMNS} FROM llm_configs ORDER BY name`).all() as any[]
  res.json(configs.map(c => ({ ...c, has_key: !!c.has_key })))
})

router.get('/:id', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const config = db.prepare(`SELECT ${CONFIG_COLUMNS} FROM llm_configs WHERE id = ?`).get(req.params.id) as any
  if (!config) return res.status(404).json({ message: '配置不存在' })
  res.json({ ...config, has_key: !!config.has_key })
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
  const result = db
    .prepare(
      'INSERT INTO llm_configs (name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      name,
      interface_format || 'OpenAI',
      base_url,
      model_name,
      api_key || '',
      temperature ?? 0.7,
      max_tokens ?? 4096,
      timeout ?? 600,
      req.user!.username,
    )
  res.json({ message: 'ok', id: result.lastInsertRowid })
})

router.put('/:id', authenticate, (req: AuthRequest, res) => {
  const { name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout } = req.body
  const db = getDB()
  const config = ownConfig(req, res)
  if (!config) return
  // 换地址时不能沿用旧 Key，否则 Key 会被发到新地址
  if (base_url !== undefined && base_url !== config.base_url && config.api_key && !api_key) {
    return res.status(400).json({ message: '修改 Base URL 时需要重新填写 API Key' })
  }
  const newName = name || config.name
  if (
    newName !== config.name &&
    db.prepare('SELECT id FROM llm_configs WHERE name = ? AND id != ?').get(newName, req.params.id)
  ) {
    return res.status(400).json({ message: '配置名称已存在' })
  }
  db.prepare(
    'UPDATE llm_configs SET name = ?, interface_format = ?, base_url = ?, model_name = ?, api_key = ?, temperature = ?, max_tokens = ?, timeout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
  ).run(
    newName,
    interface_format ?? config.interface_format,
    base_url ?? config.base_url,
    model_name ?? config.model_name,
    api_key ? api_key : config.api_key, // 留空不修改已保存的 Key
    temperature ?? config.temperature,
    max_tokens ?? config.max_tokens,
    timeout ?? config.timeout,
    req.params.id,
  )
  res.json({ message: 'ok' })
})

router.delete('/:id', authenticate, (req: AuthRequest, res) => {
  if (!ownConfig(req, res)) return
  getDB().prepare('DELETE FROM llm_configs WHERE id = ?').run(req.params.id)
  res.json({ message: 'ok' })
})

router.post('/:id/test', authenticate, async (req: AuthRequest, res) => {
  const config = ownConfig(req, res)
  if (!config) return

  try {
    if (isImageModel(config)) {
      const account = await checkImageAccount(config)
      return res.json({
        success: account.active,
        message: account.active ? `生图账号有效（订阅等级 ${account.tier}）` : '生图账号订阅未激活',
      })
    }
    const content = await invokeLLM(config, '', '请仅回复 OK。')
    res.json({ success: true, message: `对话接口正常：${content.slice(0, 100)}` })
  } catch (err: any) {
    res.json({ success: false, message: `连接失败：${redactKey(String(err.message), config)}` })
  }
})

export default router
