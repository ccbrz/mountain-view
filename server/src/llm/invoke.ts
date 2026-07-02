import { LLMConfig } from './config'
import { invokeLLM } from './adapter'
import { addLLMCallLog, updateLLMCallLog } from './logstore'

export interface InvokeContext {
  novel_id: number
  task: string
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

  if (context) {
    logId = addLLMCallLog({
      novel_id: context.novel_id,
      task: context.task,
      model_name: config.model_name,
      system_prompt: system,
      user_prompt: user,
      response: '',
      duration_ms: 0,
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
          status: 'success',
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
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
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
