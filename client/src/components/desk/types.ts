export interface LoreEntry {
  id: string
  title: string
  text: string
  keys: string[]
  enabled: boolean
  always_on: boolean
  category: string
}

export interface Settings {
  memory_through_chapter?: number
  context_tokens: number
  model_id: string
  lore_model_id?: string
  image_model_id?: string
  memory: string
  system_prompt: string
  lorebook: LoreEntry[]
  temperature: number
  max_output_tokens: number
  recent_context_chars: number
}

export interface ModelProfile {
  id: string
  name: string
  provider: string
  model: string
  base_url: string
  context_tokens?: number
  has_api_key?: boolean
}

export interface StoryContext {
  model?: ModelProfile
  system_prompt: string
  user_prompt: string
  chars: number
  warnings: string[]
  blocks: { label: string; text: string }[]
  active_lore: string[]
  recent_sources: number[]
  budget?: {
    method: string
    estimated_input_tokens: number
    output_tokens: number
    reserved_tokens: number
    context_tokens: number
    remaining_tokens: number
    blocked: boolean
    trimmed: { label: string; removed_chars: number }[]
  }
  lore_status?: {
    matched_source?: string
    id: string
    title: string
    included: boolean
    reason: string
    matched_key?: string
    chars: number
  }[]
}

export interface Chapter {
  incomplete?: boolean
  id?: number
  status?: string
  raw_script: string
  title: string
  content: string
  author_note: string
  last_context: StoryContext | null
}

export interface ChapterItem {
  id?: number
  chapter_idx: number
  title: string
  has_content: boolean
  status?: string
  word_count?: number
}

export interface MemoryVersion {
  id: number
  chapter_number: number | null
  title: string
  kind: string
  created_by: string
  created_at: string
  memory?: string
  memory_through_chapter?: number | null
  restorable?: boolean
  restore_reason?: string
  context_revision?: number
}

export interface MemoryRestore {
  id: number | null
  memory?: string
  memory_through_chapter?: number
  restorable: boolean
  restore_reason?: string
  empty_opening?: boolean
  target_chapter?: number
  context_revision: number
  settings: Settings
  base_settings: Settings
}

export interface Project {
  length_range: { min: number; max: number }
  writing_template: string
  settings: Settings
  chapters: ChapterItem[]
}

export interface Selection {
  chapter_idx: number
  before: string
  selected: string
  after: string
}

export interface Revision extends Selection {
  instruction: string
  replacement: string
  context: StoryContext
}

export interface ReviewIssue {
  dimension: string
  severity: '必改' | '可改'
  problem: string
  quote: string
  suggestion: string
  layer?: '故事' | '用笔' | '表达'
  resolution?: 'local' | 'author_decision'
  evidence?: { source: string; quote: string }[]
}

export interface ReviewBeat {
  point: number
  text: string
  status: '已写' | '弱化' | '漏写'
  quote: string
}

export interface ReviewResult {
  summary: string
  verdict: 'pass' | 'revise'
  scores: { coverage: number; prose: number; consistency: number; webnovel: number }
  total: number
  beats?: ReviewBeat[]
  issues: ReviewIssue[]
  raw?: string
}

export interface Preparation {
  facts: { source: string; quote: string; note: string }[]
  style_rules: { quote: string; rule: string }[]
  conflicts: { source: string; quote: string; plan_quote: string; problem: string }[]
}

export interface PreparationView {
  preparation_warning?: string
  artifact_id: string
  preparation: Preparation
  context: StoryContext
  source: string
  chapter_idx: number
}

export interface LengthCheck {
  chars: number
  min: number
  max: number
  status: string
}

export interface CheckView {
  artifact_id: string
  review: ReviewResult
  context: StoryContext
  source: string
  chapter_idx: number
  length: LengthCheck
}

export interface Patch {
  note: string
  find: string
  replace: string
}

export interface RepairView {
  artifact_id: string
  diagnosis?: ReviewResult
  author_decisions?: ReviewIssue[]
  blocked?: { patch: Patch; reason: string }[]
  audit?: { warning?: string }
  length?: LengthCheck & { before: number }
  contexts?: { diagnosis?: StoryContext; revision?: StoryContext; audit?: StoryContext }
  content: string
  applied: Patch[]
  failed: { patch: Patch; reason: string }[]
  context: StoryContext
  source: string
}

export type HistoryKind = 'write' | 'continue' | 'revise' | 'memory' | 'prepare' | 'check' | 'repair' | 'refine'

export interface HistoryItem {
  id: string
  kind: HistoryKind
  created_at: string
  chapter_idx: number
}

export interface Artifact extends HistoryItem {
  incomplete?: boolean
  content?: string
  replacement?: string
  memory?: string
  preparation?: Preparation
  review?: ReviewResult
  context: StoryContext
  source: Chapter & { settings: Settings; before?: string; after?: string; selected?: string }
}

export interface LocalDraft {
  chapter_idx: number
  chapter: Chapter
  base_chapter: Chapter
  settings: Settings
  base_settings: Settings
  saved_at: string
}

export interface MemoryDraft {
  original: string
  proposed: string
  content: string
  chapter_idx: number
  finalize?: { base_chapter: Chapter; base_settings: Settings }
}

export interface ContextView {
  title: string
  context: StoryContext
  preview_mode?: 'write' | 'continue'
}

export const historyLabels: Record<HistoryKind, string> = {
  write: '整章生成',
  continue: '继续写',
  revise: '选段修改',
  memory: '记忆建议',
  prepare: '写前核对',
  check: '写后核对',
  repair: '局部修订建议',
  refine: '全文精修',
}

export const memoryVersionLabels: Record<string, string> = {
  save: '保存 Memory',
  finalize: '章节定稿',
  migration: '初始 Memory',
  backup: '恢复或修改前备份',
  restore: '恢复记忆',
}

export const emptyChapter: Chapter = {
  incomplete: false,
  raw_script: '',
  title: '',
  content: '',
  author_note: '',
  last_context: null,
}

export const proseLength = (text: string) => Array.from(text.replace(/\s/gu, '')).length
export const proseCountHint = '仅统计正文，含标点、不含空格和换行；不计台本、批注和设定。'
export const chapterText = ({ raw_script, title, content, author_note, incomplete }: Chapter) =>
  JSON.stringify({ raw_script, title, content, author_note, incomplete: !!incomplete })
export const formatCount = (value: number) =>
  value >= 10000 ? `${(value / 10000).toFixed(1)} 万` : value.toLocaleString()

export type WorkspaceTool = 'settings' | 'llm-configs' | 'style'

/** Image-generation configs are chosen separately from text models. */
export const isImageModel = (model: ModelProfile) => model.provider === 'NovelAI Image'
