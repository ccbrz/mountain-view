import { LLMConfig } from './config'

/** 向量请求不继承长篇生成的 600 秒等待；时限覆盖响应头和完整响应体。 */
export async function embed(config: LLMConfig, input: string): Promise<number[]> {
  const seconds = Math.min(config.timeout > 0 ? config.timeout : 30, 30)
  try {
    const res = await fetch(`${config.base_url.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.api_key ? { Authorization: `Bearer ${config.api_key}` } : {}) },
      body: JSON.stringify({ model: config.model_name, input }),
      signal: AbortSignal.timeout(seconds * 1000),
    })
    if (!res.ok) throw new Error(`向量接口 HTTP ${res.status}，请检查模型是否支持 /embeddings 以及账号权限`)
    const data: any = await res.json()
    const vector = data?.data?.[0]?.embedding
    if (!Array.isArray(vector) || !vector.length || !vector.every(v => typeof v === 'number' && Number.isFinite(v)) || !vector.some(v => v !== 0)) {
      throw new Error('向量接口未返回有效的非零数值向量，请选择真正的 Embedding 模型')
    }
    return vector
  } catch (e: any) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') throw new Error(`Embedding 超时（${seconds} 秒，模型 ${config.model_name}）；请测试向量接口，不要使用对话模型`)
    if (e.cause?.code === 'ENOTFOUND' || e.cause?.code === 'EAI_AGAIN') throw new Error(`Embedding 无法解析服务域名（${e.cause.code}），请检查网络或 Base URL`)
    if (e.cause?.code) throw new Error(`Embedding 连接失败（${e.cause.code}），请检查服务连接`)
    throw e
  }
}

/** 相同维度不代表相同向量空间；检索只使用当前端点/模型的索引。 */
export const embeddingSpace = (config: LLMConfig) => `${config.base_url.replace(/\/+$/, '')}|${config.model_name}`
