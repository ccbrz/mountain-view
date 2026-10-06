import { LLMConfig } from './config'
import { invokeLLM } from './adapter'
import { addLLMCallLog, updateLLMCallLog } from './logstore'

export interface InvokeContext {
  novel_id: number
  task: string
}

function estimateTokens(text: string): number {
  let chinese = 0, english = 0
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff') chinese++
    else if (ch.match(/[a-zA-Z0-9]/)) english++
  }
  return Math.ceil(chinese / 1.5 + english / 4 + (text.length - chinese - english) * 0.25)
}

export async function invokeWithRetry(
  config: LLMConfig,
  system: string,
  user: string,
  retries = 3,
  context?: InvokeContext,
): Promise<string> {
  let lastErr: Error | null = null
  const startTime = Date.now()
  let logId: string | undefined

  const inputTokens = estimateTokens(system) + estimateTokens(user)
  if (context) {
    logId = addLLMCallLog({
      novel_id: context.novel_id,
      task: context.task,
      model_name: config.model_name,
      system_prompt: system,
      user_prompt: user,
      response: '',
      duration_ms: 0,
      input_tokens: inputTokens,
      status: 'pending',
    })
  }

  for (let i = 0; i < retries; i++) {
    try {
      let text = await invokeLLM(config, system, user)
      text = cleanLLMOutput(text)
      if (logId) {
        updateLLMCallLog(logId, {
          response: text,
          duration_ms: Date.now() - startTime,
          input_tokens: inputTokens,
          output_tokens: estimateTokens(text),
          status: 'success',
          error: '',
        })
      }
      return text
    } catch (err) {
      lastErr = err as Error
      if (logId) {
        updateLLMCallLog(logId, {
          response: '',
          duration_ms: Date.now() - startTime,
          status: 'error',
          error: lastErr.message,
        })
      }
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }
  throw lastErr || new Error('LLM 调用失败')
}

function cleanLLMOutput(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  // 只脱掉包裹整段输出的围栏，正文里的代码块要保留（否则整章内容会被清空）
  const fenced = stripped.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/)
  return fenced ? fenced[1].trim() : stripped
}

/**
 * 取 <chapter> 标签内的正文（约定见 prompts.CHAPTER_OUTPUT_FORMAT）。
 * 没闭合标签（输出被截断）时取到末尾；模型没按约定输出标签时原样返回。
 */
export function extractChapterBody(text: string): string {
  const m = text.match(/<chapter>([\s\S]*?)(?:<\/chapter>|$)/)
  return m ? m[1].trim() : text
}

export async function invokeWithRetryStr(
  configName: string,
  system: string,
  user: string,
  retries = 3,
): Promise<string> {
  const { getLLMConfigs } = await import('./config')
  const configs = getLLMConfigs()
  const config = configs.find((c) => c.name === configName)
  if (!config) throw new Error(`LLM 配置 "${configName}" 未找到`)
  return invokeWithRetry(config, system, user, retries)
}
