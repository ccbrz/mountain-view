import { Router } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'

import { clearVectorStore } from '../llm/vectorstore'
import { bumpContextRevision } from '../llm/doc-snapshots'
import { embed } from '../llm/embedding'
import { invokeLLM } from '../llm/adapter'

const router = Router()

// api_key 一律不出库：只暴露 has_key 供前端判断是否已配置
const CONFIG_COLUMNS =
  "id, name, interface_format, base_url, model_name, temperature, max_tokens, timeout, created_by, created_at, updated_at, (api_key != '') AS has_key"

router.get('/', authenticate, (_req: AuthRequest, res) => {
  const db = getDB()
  const configs = db.prepare(`SELECT ${CONFIG_COLUMNS} FROM llm_configs ORDER BY name`).all() as any[]
  res.json(configs.map((c) => ({ ...c, has_key: !!c.has_key })))
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

router.put('/:id', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const { name, interface_format, base_url, model_name, api_key, temperature, max_tokens, timeout } = req.body
    const db = getDB()
    const config = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(req.params.id) as any
    if (!config) return res.status(404).json({ message: '配置不存在' })

    const newName = name || config.name
    if (newName !== config.name) {
      const dup = db.prepare('SELECT id FROM llm_configs WHERE name = ? AND id != ?').get(newName, req.params.id)
      if (dup) return res.status(400).json({ message: '配置名称已存在' })
    }

    const changed = (model_name !== undefined && model_name !== config.model_name) || (base_url !== undefined && base_url !== config.base_url)
    if (changed && db.prepare('SELECT 1 FROM novels WHERE embedding_config = ? LIMIT 1').get(config.name)) {
      try {
        await embed({ ...config, base_url: base_url ?? config.base_url, model_name: model_name ?? config.model_name,
          api_key: api_key || config.api_key, timeout: timeout ?? config.timeout }, '向量连接测试')
        if (JSON.stringify(db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(config.id)) !== JSON.stringify(config)) {
          return res.status(409).json({ message: '测试期间配置已被修改，请刷新后重试' })
        }
      } catch (err: any) { return res.status(400).json({ message: `向量预检失败，原配置保留：${err.message}` }) }
    }

    db.transaction(() => {
      db.prepare(
        'UPDATE llm_configs SET name = ?, interface_format = ?, base_url = ?, model_name = ?, api_key = ?, temperature = ?, max_tokens = ?, timeout = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
      ).run(
        newName,
        interface_format ?? config.interface_format,
        base_url ?? config.base_url,
        model_name ?? config.model_name,
        api_key ? api_key : config.api_key, // 留空不修改已保存的 Key
        temperature ?? config.temperature,
        max_tokens ?? config.max_tokens,
        timeout ?? config.timeout,
        req.params.id
      )
      for (const novel of db.prepare('SELECT id, llm_config, embedding_config FROM novels').all() as any[]) {
        let tasks = novel.llm_config
        if (newName !== config.name) {
          try {
            const map = JSON.parse(tasks)
            for (const task of Object.keys(map)) if (map[task] === config.name) map[task] = newName
            tasks = JSON.stringify(map)
          } catch { if (tasks === config.name) tasks = newName }
        }
        const usesEmbedding = novel.embedding_config === config.name
        db.prepare('UPDATE novels SET llm_config = ?, embedding_config = ? WHERE id = ?')
          .run(tasks, usesEmbedding ? newName : novel.embedding_config, novel.id)
        if (usesEmbedding && (changed || newName !== config.name)) {
          clearVectorStore(novel.id)
          db.prepare("UPDATE novel_chapters SET index_status = 'pending' WHERE novel_id = ?").run(novel.id)
          bumpContextRevision(db, novel.id)
        }
      }
    })()
    res.json({ message: 'ok' })
  } catch (err) { next(err) }
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
    if (req.body?.kind === 'embedding') {
      const vector = await embed(config, '向量连接测试')
      return res.json({ success: true, message: `向量接口正常：${vector.length} 维` })
    }
    const content = await invokeLLM(config, '', '请仅回复 OK。')
    res.json({ success: true, message: `对话接口正常：${content.slice(0, 100)}` })
  } catch (err: any) {
    res.json({ success: false, message: `连接失败: ${err.message}` })
  }
})

export default router
