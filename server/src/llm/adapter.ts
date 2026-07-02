import { LLMConfig } from './config'

export async function invokeLLM(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = `${config.base_url}/chat/completions`

  const body = {
    model: config.model_name,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: config.temperature,
    max_tokens: config.max_tokens,
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), (config.timeout || 600) * 1000)

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM API error ${res.status}: ${text}`)
    }

    const data: any = await res.json()
    const content = data.choices?.[0]?.message?.content || ''
    return content
  } catch (err: any) {
    clearTimeout(timer)
    if (err.name === 'AbortError') {
      throw new Error(`LLM 请求超时 (${config.timeout}s)`)
    }
    throw err
  }
}

export async function invokeLLMWithConfigName(
  configName: string,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const { getLLMConfigByName } = await import('./config')
  const config = getLLMConfigByName(configName)
  if (!config) throw new Error(`LLM 配置 "${configName}" 未找到`)
  return invokeLLM(config, systemPrompt, userPrompt)
}
