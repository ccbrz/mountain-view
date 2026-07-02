import { getDB } from '../db'

export interface LLMConfig {
  id: number
  name: string
  interface_format: string
  base_url: string
  model_name: string
  api_key: string
  temperature: number
  max_tokens: number
  timeout: number
}

export function getLLMConfigs(): LLMConfig[] {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM llm_configs ORDER BY name').all() as any[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    interface_format: r.interface_format || 'OpenAI',
    base_url: r.base_url.replace(/\/+$/, ''),
    model_name: r.model_name,
    api_key: r.api_key || '',
    temperature: r.temperature ?? 0.7,
    max_tokens: r.max_tokens ?? 4096,
    timeout: r.timeout ?? 600,
  }))
}

export function getLLMConfigById(id: number): LLMConfig | null {
  const db = getDB()
  const row = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(id) as any
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    interface_format: row.interface_format || 'OpenAI',
    base_url: row.base_url.replace(/\/+$/, ''),
    model_name: row.model_name,
    api_key: row.api_key || '',
    temperature: row.temperature ?? 0.7,
    max_tokens: row.max_tokens ?? 4096,
    timeout: row.timeout ?? 600,
  }
}

export function getLLMConfigByName(name: string): LLMConfig | null {
  const db = getDB()
  const row = db.prepare('SELECT * FROM llm_configs WHERE name = ?').get(name) as any
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    interface_format: row.interface_format || 'OpenAI',
    base_url: row.base_url.replace(/\/+$/, ''),
    model_name: row.model_name,
    api_key: row.api_key || '',
    temperature: row.temperature ?? 0.7,
    max_tokens: row.max_tokens ?? 4096,
    timeout: row.timeout ?? 600,
  }
}
