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

const toConfig = (r: any): LLMConfig => ({
  id: r.id,
  name: r.name,
  interface_format: r.interface_format || 'OpenAI',
  base_url: r.base_url.replace(/\/+$/, ''),
  model_name: r.model_name,
  api_key: r.api_key || '',
  temperature: r.temperature ?? 0.7,
  max_tokens: r.max_tokens ?? 4096,
  timeout: r.timeout ?? 600,
})

export function getLLMConfigs(): LLMConfig[] {
  return (getDB().prepare('SELECT * FROM llm_configs ORDER BY name').all() as any[]).map(toConfig)
}

export function getLLMConfigById(id: number): LLMConfig | null {
  const row = getDB().prepare('SELECT * FROM llm_configs WHERE id = ?').get(id)
  return row ? toConfig(row) : null
}

/** 错误信息可能回显上游请求，返回前端前去掉 Key。 */
export function redactKey(message: string, config?: LLMConfig | null) {
  return config?.api_key ? message.split(config.api_key).join('[REDACTED]') : message
}
