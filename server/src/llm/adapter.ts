import { LLMConfig } from './config'

/** 把 chat.completion.chunk 流还原成非流式响应里 choices[0] 的形状 */
function parseSSE(text: string) {
  let content = ''
  let finish_reason: string | undefined
  let chunks = 0
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    chunks++
    const payload = line.slice(5).trim()
    if (!payload || payload === '[DONE]') continue
    const c = JSON.parse(payload).choices?.[0]
    content += c?.delta?.content || c?.message?.content || ''
    if (c?.finish_reason) finish_reason = c.finish_reason
  }
  if (!chunks) throw new Error('not SSE')
  // 流被中途掐断时没有 finish_reason，内容是半截的，不能当成功（实测出过截在句中的角色档案）
  if (!finish_reason) throw new StreamCutError(content.length)
  return { message: { content }, finish_reason }
}

class StreamCutError extends Error {
  constructor(len: number) { super(`模型响应流中途断开（已收到 ${len} 字，无 finish_reason）`) }
}

/**
 * 网关会无视 stream:false 直接回 SSE（2026-09-24 起 openlux 全量如此），且 content-type 不可信，
 * 所以按正文内容判断格式；先按看起来像的那种解析，失败再试另一种。
 */
function parseResponse(text: string): any {
  const body = text.trim()
  const looksSSE = body.startsWith('data:') || body.startsWith('event:') || body.includes('\ndata:')
  const asJSON = () => (JSON.parse(body) as any).choices?.[0]
  const asSSE = () => parseSSE(body)
  const [first, second] = looksSSE ? [asSSE, asJSON] : [asJSON, asSSE]
  try {
    return first()
  } catch (e) {
    if (e instanceof StreamCutError) throw e
    try {
      return second()
    } catch {
      throw new Error(`无法解析模型响应（既不是 JSON 也不是 SSE）：${body.slice(0, 200)}`)
    }
  }
}

export async function invokeLLM(
  config: LLMConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const url = `${config.base_url.replace(/\/+$/, '')}/chat/completions`

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

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`LLM API error ${res.status}: ${text}`)
    }

    const choice = parseResponse(await res.text())
    const content = choice?.message?.content || ''
    // 推理模型的思考过程也占 max_tokens，额度被思考用完时 content 为空，得报出来而不是当成空回复
    if (!content) {
      throw new Error(choice?.finish_reason === 'length'
        ? `模型输出被截断（max_tokens=${config.max_tokens} 已用完，多半耗在思考过程上），请在模型配置里调大 max_tokens`
        : `模型返回了空内容（finish_reason=${choice?.finish_reason ?? '未知'}）`)
    }
    return content
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error(`LLM 请求超时 (${config.timeout || 600}s)`)
    }
    if (err.cause?.code === 'ENOTFOUND' || err.cause?.code === 'EAI_AGAIN') throw new Error(`LLM 无法解析服务域名（${err.cause.code}），请检查网络或 Base URL`)
    if (err.cause?.code) throw new Error(`LLM 连接失败（${err.cause.code}），请检查服务连接`)
    throw err
  } finally {
    clearTimeout(timer)
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
