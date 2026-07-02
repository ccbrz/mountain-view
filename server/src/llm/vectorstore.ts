import fs from 'fs'
import path from 'path'
import { getLLMConfigByName } from './config'

interface VectorDoc {
  id: string
  text: string
  metadata: Record<string, string | number>
  embedding: number[]
}

interface VectorStoreData {
  docs: VectorDoc[]
}

const VECTOR_DIR = path.join(process.cwd(), 'data', 'vectors')

// 确保向量存储目录存在
function ensureVectorDir() {
  if (!fs.existsSync(VECTOR_DIR)) {
    fs.mkdirSync(VECTOR_DIR, { recursive: true })
  }
}

function getVectorPath(novelId: string | number): string {
  return path.join(VECTOR_DIR, `novel_${novelId}.json`)
}

export class MemoryVectorStore {
  private novelId: string
  private docs: VectorDoc[] = []
  private embeddingConfigName: string = ''

  constructor(novelId: string | number) {
    this.novelId = String(novelId)
    ensureVectorDir()
    this.load()
  }

  setEmbeddingConfig(configName: string) {
    this.embeddingConfigName = configName
  }

  private load() {
    const filePath = getVectorPath(this.novelId)
    if (fs.existsSync(filePath)) {
      try {
        const data: VectorStoreData = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        this.docs = data.docs || []
      } catch (err) {
        console.error('Failed to load vector store:', err)
        this.docs = []
      }
    }
  }

  private save() {
    const filePath = getVectorPath(this.novelId)
    const data: VectorStoreData = { docs: this.docs }
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8')
  }

  private async getEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingConfigName) {
      throw new Error('Embedding config not set')
    }

    const config = getLLMConfigByName(this.embeddingConfigName)
    if (!config) {
      throw new Error(`Embedding config "${this.embeddingConfigName}" not found`)
    }

    const url = `${config.base_url}/embeddings`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (config.api_key) {
      headers['Authorization'] = `Bearer ${config.api_key}`
    }

    const body = {
      model: config.model_name,
      input: text,
    }

    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Embedding API error ${res.status}: ${text}`)
    }

    const data: any = await res.json()
    return data.data[0].embedding
  }

  async insert(text: string, metadata: Record<string, string | number>): Promise<void> {
    const embedding = await this.getEmbedding(text)
    this.docs.push({
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      metadata,
      embedding,
    })
    this.save()
  }

  async search(query: string, k = 4): Promise<{ text: string; metadata: Record<string, string | number>; score: number }[]> {
    if (this.docs.length === 0) return []

    const queryEmbedding = await this.getEmbedding(query)

    const scored = this.docs.map((doc) => ({
      text: doc.text,
      metadata: doc.metadata,
      score: cosineSimilarity(queryEmbedding, doc.embedding),
    }))

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  clear(): void {
    this.docs = []
    this.save()
  }

  count(): number {
    return this.docs.length
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  if (denominator === 0) return 0

  return dotProduct / denominator
}

const stores = new Map<string, MemoryVectorStore>()

export function getVectorStore(novelId: string | number): MemoryVectorStore {
  const key = String(novelId)
  if (!stores.has(key)) {
    stores.set(key, new MemoryVectorStore(novelId))
  }
  return stores.get(key)!
}

export function clearVectorStore(novelId: string | number): void {
  const store = stores.get(String(novelId))
  if (store) {
    store.clear()
  }
  stores.delete(String(novelId))
  
  // 删除持久化文件
  const filePath = getVectorPath(novelId)
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath)
  }
}
