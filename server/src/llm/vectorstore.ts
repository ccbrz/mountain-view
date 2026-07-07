import { getDB } from '../db'
import { initTable } from '../schema'
import { getLLMConfigByName } from './config'

export function initVectorStore() {
  initTable('vector_embeddings', `
    id TEXT PRIMARY KEY,
    novel_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    metadata_json TEXT DEFAULT '{}',
    embedding BLOB,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  `)
  getDB().exec(`CREATE INDEX IF NOT EXISTS idx_vectors_novel ON vector_embeddings(novel_id)`)
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

function packEmbedding(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

function unpackEmbedding(buf: Buffer): number[] {
  const vec: number[] = []
  for (let i = 0; i < buf.length; i += 4) vec.push(buf.readFloatLE(i))
  return vec
}

export class PersistentVectorStore {
  private novelId: string
  private embeddingConfigName: string = ''

  constructor(novelId: string | number) {
    this.novelId = String(novelId)
  }

  setEmbeddingConfig(configName: string) {
    this.embeddingConfigName = configName
  }

  private async getEmbedding(text: string): Promise<number[]> {
    if (!this.embeddingConfigName) throw new Error('Embedding config not set')
    const config = getLLMConfigByName(this.embeddingConfigName)
    if (!config) throw new Error(`Embedding config "${this.embeddingConfigName}" not found`)

    const res = await fetch(`${config.base_url}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.api_key ? { 'Authorization': `Bearer ${config.api_key}` } : {}),
      },
      body: JSON.stringify({ model: config.model_name, input: text }),
    })
    if (!res.ok) throw new Error(`Embedding API error ${res.status}: ${await res.text()}`)
    const data: any = await res.json()
    return data.data[0].embedding
  }

  async insert(text: string, metadata: Record<string, string | number>): Promise<void> {
    const embedding = await this.getEmbedding(text)
    const db = getDB()
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      'INSERT INTO vector_embeddings (id, novel_id, text, metadata_json, embedding) VALUES (?, ?, ?, ?, ?)'
    ).run(id, this.novelId, text, JSON.stringify(metadata), packEmbedding(embedding))
  }

  async search(query: string, k = 4): Promise<{ text: string; metadata: Record<string, string | number>; score: number }[]> {
    const db = getDB()
    const rows = db.prepare('SELECT text, metadata_json, embedding FROM vector_embeddings WHERE novel_id = ?').all(this.novelId) as any[]
    if (rows.length === 0) return []

    const queryEmbedding = await this.getEmbedding(query)
    const scored = rows.map((r) => ({
      text: r.text,
      metadata: JSON.parse(r.metadata_json || '{}'),
      score: cosineSimilarity(queryEmbedding, unpackEmbedding(r.embedding)),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  clear(): void {
    getDB().prepare('DELETE FROM vector_embeddings WHERE novel_id = ?').run(this.novelId)
  }

  count(): number {
    const row = getDB().prepare('SELECT COUNT(*) as c FROM vector_embeddings WHERE novel_id = ?').get(this.novelId) as any
    return row?.c || 0
  }
}

const stores = new Map<string, PersistentVectorStore>()

export function getVectorStore(novelId: string | number): PersistentVectorStore {
  const key = String(novelId)
  if (!stores.has(key)) stores.set(key, new PersistentVectorStore(novelId))
  return stores.get(key)!
}

export function clearVectorStore(novelId: string | number): void {
  stores.delete(String(novelId))
  getDB().prepare('DELETE FROM vector_embeddings WHERE novel_id = ?').run(String(novelId))
}
