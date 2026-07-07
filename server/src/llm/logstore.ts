import { getDB } from '../db'
import { initTable } from '../schema'

export interface LLMCallLog {
  id: string
  novel_id: number
  task: string
  model_name: string
  system_prompt: string
  user_prompt: string
  response: string
  timestamp: number
  duration_ms: number
  input_tokens?: number
  output_tokens?: number
  status: 'pending' | 'success' | 'error'
  error?: string
}

export function initLogStore() {
  initTable('llm_call_logs', `
    id TEXT PRIMARY KEY,
    novel_id INTEGER NOT NULL,
    task TEXT NOT NULL,
    model_name TEXT NOT NULL,
    system_prompt TEXT DEFAULT '',
    user_prompt TEXT DEFAULT '',
    response TEXT DEFAULT '',
    timestamp INTEGER NOT NULL,
    duration_ms INTEGER DEFAULT 0,
    input_tokens INTEGER DEFAULT 0,
    output_tokens INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending',
    error TEXT DEFAULT ''
  `)
  getDB().exec(`CREATE INDEX IF NOT EXISTS idx_llm_logs_novel ON llm_call_logs(novel_id, timestamp DESC)`)
}

let logIdCounter = 0

export function addLLMCallLog(log: Omit<LLMCallLog, 'id' | 'timestamp'>): string {
  const id = `log_${++logIdCounter}_${Date.now()}`
  const entry: LLMCallLog = {
    ...log,
    id,
    timestamp: Date.now(),
  }
  const db = getDB()
  db.prepare(
    'INSERT INTO llm_call_logs (id, novel_id, task, model_name, system_prompt, user_prompt, response, timestamp, duration_ms, input_tokens, output_tokens, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    entry.id, entry.novel_id, entry.task, entry.model_name,
    entry.system_prompt || '', entry.user_prompt || '',
    entry.response || '', entry.timestamp, entry.duration_ms,
    entry.input_tokens || 0, entry.output_tokens || 0,
    entry.status, entry.error || ''
  )
  return id
}

export function updateLLMCallLog(id: string, updates: Partial<LLMCallLog>): void {
  const db = getDB()
  const sets: string[] = []
  const vals: any[] = []
  for (const [key, val] of Object.entries(updates)) {
    sets.push(`${key} = ?`)
    vals.push(val ?? '')
  }
  if (sets.length === 0) return
  vals.push(id)
  db.prepare(`UPDATE llm_call_logs SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
}

export function getLogsByNovelId(novelId: number, limit = 100): LLMCallLog[] {
  const db = getDB()
  return db.prepare(
    'SELECT * FROM llm_call_logs WHERE novel_id = ? ORDER BY timestamp DESC LIMIT ?'
  ).all(novelId, limit) as LLMCallLog[]
}

export function clearLogsByNovelId(novelId: number): void {
  const db = getDB()
  db.prepare('DELETE FROM llm_call_logs WHERE novel_id = ?').run(novelId)
}
