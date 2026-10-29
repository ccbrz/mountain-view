import { estimatedTokens } from './writer-context'
import { LLMConfig } from './config'
import { countInputTokens, invokeLLMResult, OutputTruncatedError } from './adapter'
import { addLLMCallLog, updateLLMCallLog } from './logstore'

export interface InvokeContext {
  novel_id: number
  task: string
  context_tokens?: number
}

function estimateTokens(text: string): number {
  let chinese = 0, english = 0
  for (const ch of text) {
    if (ch >= '\u4e00' && ch <= '\u9fff') chinese++
    else if (ch.match(/[a-zA-Z0-9]/)) english++
  }
  return Math.ceil(chinese / 1.5 + english / 4 + (text.length - chinese - english) * 0.25)
}

export async function invokeWithRetryResult(
  config: LLMConfig,
  system: string,
  user: string,
  retries = 3,
  context?: InvokeContext,
  acceptPartial = false,
) {
  if (context?.context_tokens) {
    const measured = await countInputTokens(config, system, user).catch(() => undefined)
    if ((measured ?? estimatedTokens(system) + estimatedTokens(user)) + config.max_tokens + 512 > context.context_tokens) throw Object.assign(new Error('必要上下文与输出预留超出配置窗口，请精简材料或调整输出上限；请求未发送。'), {status: 400})
  }
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
      const result = await invokeLLMResult(config, system, user)
      const text = cleanLLMOutput(result.content)
      const incomplete = result.finish_reason === 'length'
      if (incomplete && (!acceptPartial || !text || text.includes('<think>'))) throw new OutputTruncatedError(text)
      if (logId) {
        updateLLMCallLog(logId, {
          response: text,
          duration_ms: Date.now() - startTime,
          input_tokens: inputTokens,
          output_tokens: estimateTokens(text),
          status: incomplete ? 'error' : 'success',
          error: incomplete ? '达到单次输出上限，已保留未完成的正文草稿' : '',
        })
      }
      return { text, incomplete, finish_reason: result.finish_reason }
    } catch (err) {
      lastErr = err as Error
      if (logId) {
        updateLLMCallLog(logId, {
          response: lastErr instanceof OutputTruncatedError ? lastErr.partial : '',
          duration_ms: Date.now() - startTime,
          status: 'error',
          error: lastErr.message,
        })
      }
      if (lastErr instanceof OutputTruncatedError) throw lastErr
      if (i < retries - 1) {
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }
  throw lastErr || new Error('LLM 调用失败')
}

/** Structured results must be complete; only the writing desk opts into partial prose. */
export async function invokeWithRetry(config: LLMConfig, system: string, user: string, retries = 3, context?: InvokeContext): Promise<string> {
  return (await invokeWithRetryResult(config, system, user, retries, context)).text
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
