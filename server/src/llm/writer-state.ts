/** Canonical state shared by the writing desk and the retained review tools. */
export const WRITER_DOC = 'writing_desk'
export interface LoreEntry { id: string; title: string; text: string; keys: string[]; enabled: boolean; always_on: boolean; category: string }
export interface WriterSettings { schema_version?: number; writing_template_version?: number; model_id: string; system_prompt: string; memory: string; memory_through_chapter?: number; lorebook: LoreEntry[]; temperature: number; max_output_tokens: number; recent_context_chars: number; context_tokens: number }
export function unifiedWriterState(db: any, novelId: number): WriterSettings | null {
  const row = db.prepare('SELECT content FROM novel_docs WHERE novel_id=? AND doc_type=?').get(novelId, WRITER_DOC)
  if (!row) return null
  const state = JSON.parse(row.content)
  return state.schema_version === 2 ? state : null
}
export function writerDoc(db: any, novelId: number, type: string): string | undefined {
  if (!['architecture', 'characters', 'progress'].includes(type)) return undefined
  const state = unifiedWriterState(db, novelId)
  if (!state) return undefined
  if (type === 'progress') return state.memory
  return state.lorebook.filter(e => e.enabled && (type === 'characters' ? e.category === '人物' : e.category !== '人物')).map(e => `## ${e.title}\n${e.text}`).join('\n\n')
}
export function recentWriterProse(db: any, novelId: number, chapter: number, budget: number): { chapter_number: number; content: string }[] {
  const recent: { chapter_number: number; content: string }[] = []
  if (budget <= 0) return recent
  const rows = db.prepare(`SELECT chapter_number, substr(content, -?) AS content FROM novel_chapters
    WHERE novel_id=? AND chapter_number<? AND length(trim(content))>0 ORDER BY chapter_number DESC`).iterate(budget, novelId, chapter)
  let left = budget
  for (const row of rows as Iterable<any>) {
    const content = Array.from(row.content as string).slice(-left).join('')
    recent.unshift({ chapter_number: row.chapter_number, content }); left -= Array.from(content).length
    if (left <= 0) break
  }
  return recent
}
