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
  status: 'pending' | 'success' | 'error'
  error?: string
}

const logs: LLMCallLog[] = []
const MAX_LOGS = 500

let logIdCounter = 0

export function addLLMCallLog(log: Omit<LLMCallLog, 'id' | 'timestamp'>): string {
  const id = `log_${++logIdCounter}_${Date.now()}`
  const entry: LLMCallLog = {
    ...log,
    id,
    timestamp: Date.now(),
  }
  logs.unshift(entry)
  if (logs.length > MAX_LOGS) {
    logs.length = MAX_LOGS
  }
  return id
}

export function updateLLMCallLog(id: string, updates: Partial<LLMCallLog>): void {
  const log = logs.find((l) => l.id === id)
  if (log) {
    Object.assign(log, updates)
  }
}

export function getLogsByNovelId(novelId: number, limit = 100): LLMCallLog[] {
  return logs
    .filter((l) => l.novel_id === novelId)
    .slice(0, limit)
}

export function clearLogsByNovelId(novelId: number): void {
  const indicesToRemove: number[] = []
  logs.forEach((l, i) => {
    if (l.novel_id === novelId) indicesToRemove.push(i)
  })
  for (let i = indicesToRemove.length - 1; i >= 0; i--) {
    logs.splice(indicesToRemove[i], 1)
  }
}
