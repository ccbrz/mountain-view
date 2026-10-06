import { getDB } from '../db'
import { initTable } from '../schema'
import { getLLMConfigByName } from './config'
import { embed, embeddingSpace } from './embedding'
import { randomUUID } from 'node:crypto'

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
  // 旧索引未记录向量空间，不能证明与当前模型兼容；保留正文与记忆，仅标记待重建。
  getDB().transaction(() => {
    getDB().exec(`UPDATE novel_chapters SET index_status = 'pending' WHERE EXISTS (
      SELECT 1 FROM vector_embeddings v WHERE v.novel_id = novel_chapters.novel_id
        AND json_extract(v.metadata_json, '$.chapter') = novel_chapters.chapter_number
        AND json_extract(v.metadata_json, '$.embedding_space') IS NULL
    ); DELETE FROM vector_embeddings WHERE json_extract(metadata_json, '$.embedding_space') IS NULL;`)
  })()
  getDB().exec(`DELETE FROM vector_embeddings WHERE NOT EXISTS (
    SELECT 1 FROM novel_chapters c WHERE c.novel_id = vector_embeddings.novel_id
      AND c.chapter_number = json_extract(vector_embeddings.metadata_json, '$.chapter') AND c.status = 'finalized'
  )`)
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

    return embed(config, text)
  }

  private space(): string {
    const config = getLLMConfigByName(this.embeddingConfigName)
    if (!config) throw new Error('请先选择有效的 Embedding 配置')
    return embeddingSpace(config)
  }

  async insert(text: string, metadata: Record<string, string | number>): Promise<void> {
    const embedding = await this.getEmbedding(text)
    const db = getDB()
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    db.prepare(
      'INSERT INTO vector_embeddings (id, novel_id, text, metadata_json, embedding) VALUES (?, ?, ?, ?, ?)'
    ).run(id, this.novelId, text, JSON.stringify({ ...metadata, embedding_space: this.space() }), packEmbedding(embedding))
  }

  /** 网络请求阶段不改库，全部成功后由调用方在版本检查事务里替换。 */
  async prepareChapter(content: string): Promise<{ text: string; embedding: Buffer }[]> {
    const segments: { text: string; embedding: Buffer }[] = []
    for (let i = 0; i < content.length; i += 500) {
      const text = content.slice(i, i + 500)
      segments.push({ text, embedding: packEmbedding(await this.getEmbedding(text)) })
    }
    return segments
  }

  replaceChapter(chapterNum: number, segments: { text: string; embedding: Buffer }[]) {
    const db = getDB()
    db.transaction(() => {
      this.deleteChapter(chapterNum)
      const insert = db.prepare('INSERT INTO vector_embeddings (id, novel_id, text, metadata_json, embedding) VALUES (?, ?, ?, ?, ?)')
      for (const seg of segments) {
        insert.run(randomUUID(), this.novelId, seg.text, JSON.stringify({ novel_id: this.novelId, chapter: chapterNum, embedding_space: this.space() }), seg.embedding)
      }
    })()
  }

  async search(
    query: string,
    k = 4,
    filter?: (metadata: Record<string, string | number>) => boolean,
  ): Promise<{ text: string; metadata: Record<string, string | number>; score: number }[]> {
    const db = getDB()
    const rows = (db.prepare("SELECT v.text, v.metadata_json, v.embedding FROM vector_embeddings v JOIN novel_chapters c ON c.novel_id = v.novel_id AND c.chapter_number = json_extract(v.metadata_json, '$.chapter') WHERE v.novel_id = ? AND c.status = 'finalized'").all(this.novelId) as any[])
      .map((r) => ({ ...r, metadata: JSON.parse(r.metadata_json || '{}') }))
      .filter((r) => r.metadata.embedding_space === this.space() && (!filter || filter(r.metadata)))
    if (rows.length === 0) return []

    const queryEmbedding = await this.getEmbedding(query)
    if (rows.some(r => r.embedding.length !== queryEmbedding.length * 4)) throw new Error('向量维度与现有索引不一致，请重建索引')
    const scored = rows.map((r) => ({
      text: r.text,
      metadata: r.metadata,
      score: cosineSimilarity(queryEmbedding, unpackEmbedding(r.embedding)),
    }))
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  /** 重新定稿前删掉该章旧版本的片段，免得新旧两版同时被检索到 */
  deleteChapter(chapterNum: number): void {
    getDB().prepare("DELETE FROM vector_embeddings WHERE novel_id = ? AND json_extract(metadata_json, '$.chapter') = ?")
      .run(this.novelId, chapterNum)
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
