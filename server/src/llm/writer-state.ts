/** Canonical writing-desk state: the only Memory and Lorebook of a novel. */
import { WRITING_TEMPLATE } from './prompts'

export const WRITER_DOC = 'writing_desk'
export interface LoreEntry {
  id: string
  title: string
  text: string
  keys: string[]
  enabled: boolean
  always_on: boolean
  category: string
}
export interface WriterSettings {
  model_id: string
  lore_model_id?: string
  image_model_id?: string
  system_prompt: string
  memory: string
  memory_through_chapter?: number
  lorebook: LoreEntry[]
  temperature: number
  max_output_tokens: number
  recent_context_chars: number
  context_tokens: number
}
export const DEFAULT_WRITER_SETTINGS: WriterSettings = {
  model_id: '',
  system_prompt: WRITING_TEMPLATE,
  memory: '',
  memory_through_chapter: 0,
  lorebook: [],
  temperature: 0.55,
  max_output_tokens: 4096,
  recent_context_chars: 6000,
  context_tokens: 32768,
}
/** Saved settings, or the defaults a new book starts from (not persisted until the author saves). */
export function writerSettings(db: any, novelId: number): WriterSettings {
  const row = db.prepare('SELECT content FROM novel_docs WHERE novel_id=? AND doc_type=?').get(novelId, WRITER_DOC)
  return row ? JSON.parse(row.content) : structuredClone(DEFAULT_WRITER_SETTINGS)
}
/** Enabled Lorebook entries rendered as reference text, split into characters and everything else. */
export function loreText(settings: WriterSettings, category: 'characters' | 'world') {
  return settings.lorebook
    .filter(e => e.enabled && (category === 'characters') === (e.category === '人物'))
    .map(e => `## ${e.title}\n${e.text}`)
    .join('\n\n')
}
export function recentWriterProse(
  db: any,
  novelId: number,
  chapter: number,
  budget: number,
): { chapter_number: number; content: string }[] {
  const recent: { chapter_number: number; content: string }[] = []
  if (budget <= 0) return recent
  const rows = db
    .prepare(
      `SELECT chapter_number, substr(content, -?) AS content FROM novel_chapters
    WHERE novel_id=? AND chapter_number<? AND length(trim(content))>0 ORDER BY chapter_number DESC`,
    )
    .iterate(budget, novelId, chapter)
  let left = budget
  for (const row of rows as Iterable<any>) {
    const content = Array.from(row.content as string)
      .slice(-left)
      .join('')
    recent.unshift({ chapter_number: row.chapter_number, content })
    left -= Array.from(content).length
    if (left <= 0) break
  }
  return recent
}
