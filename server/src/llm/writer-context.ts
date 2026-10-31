import { selectStyleSamples } from './writer-style'
import { WriterSettings, LoreEntry, recentWriterProse } from './writer-state'
import * as P from './prompts'
import { LLMConfig } from './config'
import { countInputTokens, isNovelAIKayra } from './adapter'
import { chapterContract, PREPARATION_SYSTEM, WriterPreparation } from './writer-preparation'

export interface WriterInput {
  chapter_idx: number; title: string; raw_script: string; content: string; author_note: string; settings: WriterSettings
  mode?: string; before?: string; selected?: string; after?: string; instruction?: string; rejected_notes?: string[]; lore_entry?: LoreEntry; preparation?: WriterPreparation; scan_hints?: string
}
interface Block { label: string; text: string; trim?: 'start' | 'end' | 'drop'; keep?: number; priority?: number; lore_id?: string; chapter_number?: number }
const chars = (s: string) => Array.from(s)
const tail = (s: string, n: number) => chars(s).slice(-n).join('')
const render = (blocks: Block[]) => blocks.filter(b => b.text.trim()).map(b => `【${b.label.replace(/^Lorebook · /, '设定 · ')}】\n${b.text}`).join('\n\n')

// ponytail: UTF-8 byte counting is a conservative estimate for arbitrary providers, not a model tokenizer.
// Keep the method visible; a provider tokenizer can replace this when its model is supported locally.
export function estimatedTokens(text: string) { return Buffer.byteLength(text, 'utf8') }

export function selectWriterLore(s: WriterSettings, input: WriterInput, kind: string, recent: {content: string}[]) {
  const sources = [
    {label: '修改要求', text: input.instruction || ''},
    {label: '作者批注', text: input.author_note},
    {label: '章节标题', text: input.title},
    ...(kind === 'revise' ? [
      {label: '待修改选区', text: input.selected || ''},
      {label: '选区附近正文', text: tail(input.before || '', 2000) + '\n' + chars(input.after || '').slice(0, 2000).join('')},
    ] : [
      // A whole-chapter task needs the whole plan; continuation must not activate far-future plan entries.
      ...(['write', 'review', 'patch', 'audit', 'prepare'].includes(kind) ? [{label: '本章台本', text: input.raw_script}] : []),
      ...(kind === 'write' || kind === 'prepare' && input.mode !== 'continue' ? [] : [{label: '本章正文末尾', text: tail(input.content, 6000)}]),
      {label: '近期正文', text: tail(recent.map(r => r.content).join('\n'), 6000)},
    ]),
  ].map(source => ({...source, text: source.text.toLocaleLowerCase()}))
  return s.lorebook.map(e => {
    const source = sources.find(source => e.keys.some(key => key.trim() && source.text.includes(key.trim().toLocaleLowerCase())))
    const key = source && e.keys.find(key => key.trim() && source.text.includes(key.trim().toLocaleLowerCase()))?.trim()
    const included = !!(e.enabled && e.text.trim() && (e.always_on || source))
    return {id: e.id, title: e.title, included,
      reason: !e.enabled ? '已禁用' : !e.text.trim() ? '正文为空' : e.always_on ? '常驻' : source ? '触发词匹配' : e.keys.some(k => k.trim()) ? '无触发词匹配' : '无有效触发词',
      matched_key: included && !e.always_on ? key || '' : '', matched_source: included && !e.always_on ? source?.label || '' : '', chars: chars(e.text).length}
  })
}

/** Budget the exact rendered messages. Never trim facts, the plan, instructions or the target selection. */
function fitBlocks(system: string, blocks: Block[], settings: WriterSettings, count = estimatedTokens) {
  const overhead = 512, limit = settings.context_tokens - settings.max_output_tokens - overhead
  const used = () => count(system) + count(render(blocks))
  const trimmed: {label: string; removed_chars: number}[] = []
  for (const block of blocks.filter(b => b.trim).sort((a, b) => (a.priority || 0) - (b.priority || 0))) {
    if (used() <= limit) break
    const original = chars(block.text), keep = Math.min(block.keep || 0, original.length)
    const take = (n: number) => n === 0 ? '' : (block.trim === 'start' ? original.slice(-n) : original.slice(0, n)).join('')
    block.text = take(keep)
    if (block.trim !== 'drop' && used() <= limit) {
      let low = keep, high = original.length
      while (low < high) {
        const mid = Math.ceil((low + high) / 2)
        block.text = take(mid)
        if (used() <= limit) low = mid; else high = mid - 1
      }
      block.text = take(low)
      // Keep complete neighboring paragraphs when possible, while retaining the protected tail/head.
      const line = block.trim === 'start' ? block.text.indexOf('\n') : block.text.lastIndexOf('\n')
      const bounded = line < 0 ? block.text : block.trim === 'start' ? block.text.slice(line + 1) : block.text.slice(0, line)
      if (line >= 0 && (block.trim === 'start' ? line + 1 : block.text.length - line) <= 256 && chars(bounded).length >= keep) block.text = bounded
    }
    if (original.length > chars(block.text).length) trimmed.push({label: block.label, removed_chars: original.length - chars(block.text).length})
  }
  const input = used(), remaining = limit - input
  return {method: 'utf8-conservative', estimated_input_tokens: input, output_tokens: settings.max_output_tokens,
    reserved_tokens: overhead, context_tokens: settings.context_tokens, remaining_tokens: remaining, blocked: remaining < 0, trimmed}
}

export function buildWriterContext(db: any, novel: any, input: WriterInput, kind = input.mode || 'write', count = estimatedTokens) {
  const s = input.settings, blocks: Block[] = [], warnings: string[] = []
  const add = (label: string, text: string, options: Partial<Block> = {}) => { if (text.trim()) blocks.push({label, text, ...options}) }
  const recent = ['memory', 'lore'].includes(kind) ? [] : recentWriterProse(db, novel.id, input.chapter_idx, s.recent_context_chars)
  const lore_status = ['memory', 'lore'].includes(kind) ? [] : selectWriterLore(s, input, kind, recent)
  const style = novel.style_guide || ''
  let system = P.writerSystemPrompt(s.system_prompt, style, ['revise', 'patch', 'prepare'].includes(kind) ? undefined : novel.word_number || 2000)
  if (kind !== 'lore') add('Memory', s.memory)
  if (kind !== 'lore' && s.memory.trim() && s.memory_through_chapter !== undefined) add('Memory 记录时点', s.memory_through_chapter === 0 ? '开篇之前；本章台本尚未发生。' : `截至第 ${s.memory_through_chapter} 章结束，不代表待写章节开篇的状态。`)
  if (!['lore', 'memory'].includes(kind) && s.memory.trim() && s.memory_through_chapter === undefined) warnings.push('旧 Memory 的记忆进度尚未确认。可预览恢复有来源校验的历史版本，或根据已确认正文整理并保存记忆；系统不会猜测时间点。')
  if (kind === 'lore') {
    system = P.LORE_POLISH_SYSTEM
    add('条目名称', input.lore_entry?.title || '')
    add('条目分类', input.lore_entry?.category || '未分类')
    add('待整理设定原文', input.lore_entry?.text || '')
    add('本次任务', '整理结构并润色已有细节，保留全部事实和关系方向。可增强措辞、质感与节奏，保留必要的描写，不压成摘要，也不逐项扩写。不补原文未说明的原因、目的、经历或功能；不强化性格程度，不替含混事实选定解释，删去重复评价和套话。只输出本条目的整理后正文。')
  } else if (kind === 'memory') {
    system = '你是小说事实记录员，只根据已确认正文和旧记忆整理事实，不创作情节。'
    add('本章已确认正文（唯一新事实来源）', input.content)
    add('本次任务', '更新旧 Memory，输出简洁完整的替换稿。保留仍有效的事实，更新人物状态、物品归属、知情范围和未解线索；区分猜测和已证实事实。不依据台本推测未来。只输出记忆文本，供作者核对。')
  } else {
    for (const entry of s.lorebook) if (lore_status.some(e => e.id === entry.id && e.included)) {
      const source = lore_status.find(e => e.id === entry.id)?.matched_source
      const priority = source === '修改要求' || source === '作者批注' || source === '待修改选区' ? 60 : source === '本章台本' ? 50 : 40
      add('Lorebook · ' + (entry.title || entry.id), entry.text, {lore_id: entry.id, ...(!entry.always_on ? {trim: 'drop' as const, priority} : {})})
    }
    recent.forEach((r, i) => add(`近期正文 · 第 ${r.chapter_number} 章`, r.content, {trim: 'start', priority: i / Math.max(recent.length, 1), chapter_number: r.chapter_number}))
    add('章节标题', input.title)
    add('本章完整台本（计划，不代表已发生）', input.raw_script)
    if (kind !== 'prepare') {
      const query = [input.author_note, input.instruction, kind === 'revise' ? input.selected : input.raw_script,
        kind === 'continue' ? tail(input.content, 1000) : ''].filter(Boolean).join('\n')
      for (const sample of selectStyleSamples(db, novel, query)) add(`范文参考 · ${sample.id} · ${sample.kind}（只学写法，不复用事实）`, sample.text, {trim: 'drop', priority: 10})
    }
    if (kind === 'revise') {
      add('选区前文（只读）', input.before || '', {trim: 'start', keep: 500, priority: 20})
      add('待修改选区', input.selected || '')
      add('选区后文（只读）', input.after || '', {trim: 'end', keep: 500, priority: 21})
    } else if (kind !== 'write' && (kind !== 'prepare' || input.mode === 'continue')) add('本章现有正文', input.content, ['review', 'patch', 'audit'].includes(kind) ? {} : {trim: 'start', keep: 1000, priority: 20})
    if (kind === 'prepare') {
      system = PREPARATION_SYSTEM
      add('固定写作要求（保留原文）', s.system_prompt)
      add('写作位置与范围', chapterContract(input.chapter_idx, input.raw_script, input.mode || 'write'))
    } else if (kind === 'review') {
      system = P.WRITER_REVIEW_SYSTEM
      add('本书写作要求与文风（审稿依据）', [s.system_prompt, novel.style_guide].filter(Boolean).join('\n\n'))
      add('表达扫描线索（只供定位，不直接判错或扣分；作者文风优先）', input.scan_hints || '', {trim: 'drop', priority: 15})
    } else if (kind === 'patch') {
      system = P.patchReviseSystemPrompt(novel.style_guide || '', s.system_prompt)
      add('已知但保留的问题（不要修改）', (input.rejected_notes || []).join('\n'))
    } else if (kind === 'audit') {
      system = P.WRITER_REPAIR_AUDIT_SYSTEM
      add('本书写作要求与文风（审稿依据）', [s.system_prompt, novel.style_guide].filter(Boolean).join('\n\n'))
    }
    if (['write', 'continue'].includes(kind)) {
      add('本章执行约定', chapterContract(input.chapter_idx, input.raw_script, kind))
      if (input.preparation?.facts.length) add('写前核对（引用原始资料，不新增设定）', input.preparation.facts.map(f => `${f.source}「${f.quote}」：${f.note}`).join('\n'))
    }
    // Chapter-specific guidance is adjacent to the task, after long prose and examples.
    add('小说写作指引', novel.guidance || '')
    add('作者批注', input.author_note)
    add('修改要求', input.instruction || '')
    const task = kind === 'prepare' ? '核对本章起点、Memory 时间点与角色知情边界。只输出指定 JSON，不写正文、不改台本。'
      : kind === 'review' ? '逐条核对以上编号台本与本章正文，结合当前 Memory 和激活设定审稿。只输出符合审稿规范的 JSON，必须包含 beats、issues 和 scores（prose、consistency、webnovel）。'
      : kind === 'patch' ? '仅落实修改要求，已知但保留的问题不要动。只输出查找—替换补丁 JSON 数组，每项包含 note、find、replace；find 必须逐字引用原文并唯一，不输出正文或解释。'
      : kind === 'audit' ? '核验修改要求中编号补丁的候选结果。每项必须独立安全，不得依赖其他补丁被采用。只返回逐条核验 JSON，指出仍需作者决定的问题；不修改正文。'
      : kind === 'revise' ? `只改写【待修改选区】，原选区 ${Array.from((input.selected || '').replace(/\s/gu, '')).length} 字（含标点、不含空白）。只输出该选区的替换文字，不输出前后文、整章正文或解释。选区前文和后文会原样保留，严禁复述其中的动作、对白和情节。选区可能从句子中间开始或结束，输出必须直接接在前文末尾并接上后文开头，不要重写选区外的半句话。按修改要求控制范围：精简时替换文字不得长于原选区，润色时保持原有信息量，只有明确要求扩写时才增加细节。不要再次执行本章台本或发展新剧情。交稿前检查“原前文＋替换文字＋原后文”的衔接与重复。`
      : kind === 'continue' ? '从现有正文末尾继续完成台本，只输出新增正文，不重述、不越过台本结束点。'
      : '本次是按台本从头创作完整章节。必须从本章台本的第一个事件写起，按顺序覆盖全部事件、关键行动、对白与线索，停在台本最后一个事件。设定中的后续剧情和人物秘密仅作背景，不得提前展开或揭示。只输出本章完整正文。'
    add('本次任务', [task, ...(['write', 'continue'].includes(kind) ? [P.LENGTH_BRIEF(novel.word_number || 2000), ...(kind === 'continue' ? [`当前正文已有 ${Array.from(input.content.replace(/\s/gu, '')).length} 字；上述目标指已有正文与本次新增正文的合计。只补台本剩余内容，不为凑字数越过台本结束点。`] : [])] : [])].join('\n\n'))
  }
  const budget = fitBlocks(system, blocks, s, count)
  if (budget.trimmed.length) warnings.push('为保留任务、台本与当前记忆，已裁剪：' + budget.trimmed.map(b => `${b.label}（${b.removed_chars} 字符）`).join('、'))
  if (budget.blocked) warnings.push('必要上下文加输出预留仍超过配置窗口。请精简台本、Memory、常驻设定或写作要求，或调低输出上限；不会截断这些必要内容，也不会发送超出当前估算预算的请求。')
  for (const status of lore_status) if (status.included && !blocks.some(b => b.lore_id === status.id && b.text.trim())) {status.included = false; status.reason = '预算不足，未带入'}
  const included = blocks.filter(b => b.text.trim()), user = render(included)
  const recent_sources = included.filter(b => b.chapter_number !== undefined).map(b => b.chapter_number!)
  if (input.chapter_idx > 1 && !['memory', 'lore'].includes(kind) && !recent_sources.length) warnings.push('没有带入前章正文，请检查前章保存状态与近期正文预算。')
  return {system_prompt: system, user_prompt: user, chars: chars(system + user).length,
    blocks: included.map(({label, text}) => ({label, text})), warnings, lore_status,
    active_lore: lore_status.filter(e => e.included).map(e => e.id), recent_sources, budget}
}

/** Prefer the model's tokenizer before dropping any prose or lore. */
export async function buildModelWriterContext(db: any, novel: any, input: WriterInput, config: LLMConfig | null | undefined, kind = input.mode || 'write') {
  const conservative = buildWriterContext(db, novel, input, kind)
  if (!config || isNovelAIKayra(config) || new URL(config.base_url).hostname !== 'text.novelai.net') return conservative
  try {
    const full = buildWriterContext(db, novel, input, kind, () => 0)
    // At most two count requests: full materials first, then the conservative trimmed candidate.
    for (const candidate of [full, conservative]) {
      const tokens = await countInputTokens(config, candidate.system_prompt, candidate.user_prompt)
      if (tokens === undefined) return conservative
      const remaining = input.settings.context_tokens - input.settings.max_output_tokens - 512 - tokens
      if (remaining >= 0) {
        candidate.budget = {...candidate.budget, method: 'novelai-token-count', estimated_input_tokens: tokens, remaining_tokens: remaining, blocked: false}
        candidate.warnings = candidate.warnings.filter(w => !w.startsWith('必要上下文加输出预留'))
        return candidate
      }
      if (!conservative.budget.trimmed.length) break
    }
  } catch {
    conservative.warnings.unshift('NovelAI token 计数暂不可用，已回退到保守估算；未放宽容量限制。')
  }
  return conservative
}

export function requireWriterBudget(context: ReturnType<typeof buildWriterContext>) {
  if (context.budget.blocked) throw new Error(context.warnings.join('\n'))
  return context
}
