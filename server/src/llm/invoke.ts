import { estimatedTokens } from './writer-context'
import { LLMConfig } from './config'
import { countInputTokens, invokeLLMResult, OutputTruncatedError, StreamCutError, type DeltaHandler } from './adapter'
import { addLLMCallLog, updateLLMCallLog } from './logstore'

export interface InvokeContext {
  novel_id: number
  task: string
  context_tokens?: number
}

function estimateTokens(text: string): number {
  let chinese = 0,
    english = 0
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
  /** Live preview of prose as it streams in; the returned text is still the authoritative result. */
  onDelta?: DeltaHandler,
) {
  if (context?.context_tokens) {
    const measured = await countInputTokens(config, system, user).catch(() => undefined)
    if (
      (measured ?? estimatedTokens(system) + estimatedTokens(user)) + config.max_tokens + 512 >
      context.context_tokens
    )
      throw Object.assign(new Error('必要上下文与输出预留超出配置窗口，请精简材料或调整输出上限；请求未发送。'), {
        status: 400,
      })
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
      const result = await invokeLLMResult(config, system, user, onDelta)
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
      // Prose survives a cut stream as an unfinished draft, like a length cut; structured output does not.
      const partial = lastErr instanceof StreamCutError ? cleanLLMOutput(lastErr.partial) : ''
      if (acceptPartial && partial && !partial.includes('<think>')) {
        if (logId)
          updateLLMCallLog(logId, {
            response: partial,
            duration_ms: Date.now() - startTime,
            output_tokens: estimateTokens(partial),
            status: 'error',
            error: '响应流中途断开，已保留未完成的正文草稿',
          })
        return { text: partial, incomplete: true, finish_reason: 'stream_cut' }
      }
      if (logId) {
        updateLLMCallLog(logId, {
          response: lastErr instanceof OutputTruncatedError || lastErr instanceof StreamCutError ? lastErr.partial : '',
          duration_ms: Date.now() - startTime,
          status: 'error',
          error: lastErr.message,
        })
      }
      // Repeating the same request would hit the same cap and cost again.
      if (lastErr instanceof OutputTruncatedError || lastErr instanceof StreamCutError) throw lastErr
      if (i < retries - 1) {
        await new Promise(r => setTimeout(r, 1000 * (i + 1)))
      }
    }
  }
  throw lastErr || new Error('LLM 调用失败')
}

/** Structured results must be complete; only the writing desk opts into partial prose. */
export async function invokeWithRetry(
  config: LLMConfig,
  system: string,
  user: string,
  retries = 3,
  context?: InvokeContext,
): Promise<string> {
  return (await invokeWithRetryResult(config, system, user, retries, context)).text
}

function cleanLLMOutput(text: string): string {
  const stripped = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
  // 只脱掉包裹整段输出的围栏，正文里的代码块要保留（否则整章内容会被清空）
  const fenced = stripped.match(/^```[a-zA-Z]*\n([\s\S]*)\n```$/)
  return fenced ? fenced[1].trim() : stripped
}
