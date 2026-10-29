/** Author-controlled writing desk. Uses the existing accounts, models, chapters and revision store. */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { getLLMConfigs, getLLMConfigById, LLMConfig } from '../llm/config'
import { invokeWithRetryResult } from '../llm/invoke'
import { getNovelOrForbid, getLLMConfigForTask, saveChapterContent } from './novel-generator'
import { writeOutline } from '../llm/outline-review'
import { assertContextRevision, bumpContextRevision, ContextConflict } from '../llm/doc-snapshots'
import * as P from '../llm/prompts'
import { buildModelWriterContext, requireWriterBudget } from '../llm/writer-context'
import { renderProgress } from '../llm/progress'
import { WRITER_DOC as DOC, WriterSettings as Settings, LoreEntry } from '../llm/writer-state'
import { parsePreparation, requireMemoryTime } from '../llm/writer-preparation'
import { reviewChapter, ReviewResult } from '../llm/review'
import { revisePatchwise, ReviseResult } from '../llm/revise'
import { auditRefinement, localIssues, issueNote, proseChars } from '../llm/writer-refinement'
import { recordWriterMemory, memoryVersionStatus, memoryBeforeChapter, invalidateWriterMemory } from '../llm/writer-memory'
import { OutputTruncatedError } from '../llm/adapter'

const router = Router()
const fail = (text: string) => { throw new Error(text) }
const text = (value: any, max: number, label: string): string => typeof value === 'string' && value.length <= max ? value : fail(`${label}必须是文本，最多 ${max} 字符`)
function integer(value: any, min: number, max: number, label: string) { if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}范围 ${min}–${max}`); return value }
function doc(novelId: number, type: string) { return (getDB().prepare('SELECT content FROM novel_docs WHERE novel_id=? AND doc_type=?').get(novelId, type) as any)?.content || '' }
const publicModel = (c: LLMConfig) => ({ id: String(c.id), name: c.name, provider: c.interface_format, model: c.model_name, base_url: c.base_url, has_api_key: !!c.api_key })
function initial(novel: any, req: AuthRequest): Settings {
  const config = getLLMConfigForTask(novel, req, 'chapter')
  const lorebook: LoreEntry[] = []
  const architecture = doc(novel.id, 'architecture')
  if (architecture.trim()) lorebook.push({ id: 'source-world', title: '小说架构与世界观', text: architecture, keys: [], enabled: true, always_on: true, category: '世界' })
  const chars = doc(novel.id, 'characters')
  const matches = [...chars.matchAll(/^##\s+(.+)\r?$/gm)]
  if (matches.length) matches.forEach((m, i) => {
    const name = m[1].trim()
    lorebook.push({ id: `source-character-${i}`, title: name, text: chars.slice(m.index!, matches[i + 1]?.index ?? chars.length).trim(), keys: [name], enabled: true, always_on: false, category: '人物' })
  })
  else if (chars.trim()) lorebook.push({ id: 'source-characters', title: '原有角色档案', text: chars, keys: [], enabled: true, always_on: true, category: '人物' })
  return { schema_version: 2, writing_template_version: 3, model_id: config ? String(config.id) : '', system_prompt: P.WRITING_TEMPLATE, memory: '', memory_through_chapter: 0, lorebook, temperature: config?.temperature ?? .55, max_output_tokens: config?.max_tokens ?? 4096, recent_context_chars: 6000, context_tokens: 32768 }
}
function recordMemory(novelId: number, memory: string, kind: string, user: string, chapter?: number, title = '', through?: number) {
  recordWriterMemory(getDB(), novelId, memory, kind, user, chapter, title, through)
}
function settings(novel: any, req: AuthRequest): Settings {
  const stored = doc(novel.id, DOC)
  if (stored) return JSON.parse(stored)
  return initial(novel, req)
}
function initialize(novel: any, req: AuthRequest): Settings {
  const db = getDB(), stored = doc(novel.id, DOC), value: Settings = stored ? JSON.parse(stored) : initial(novel, req)
  if (value.schema_version === 2 && value.writing_template_version === 3 && stored) return value
  db.transaction(() => {
    // Only replace the exact shipped default; never overwrite author-edited rules.
    if (value.writing_template_version === 1) {
      if (value.system_prompt === P.LEGACY_WRITING_TEMPLATE) value.system_prompt = P.WRITING_TEMPLATE
      else if (value.system_prompt.startsWith(P.LEGACY_WRITING_TEMPLATE + '\n\n【作者自定义要求】\n')) value.system_prompt = P.WRITING_TEMPLATE + value.system_prompt.slice(P.LEGACY_WRITING_TEMPLATE.length)
    } else if (value.writing_template_version === 2) {
      if (value.system_prompt === P.PREVIOUS_WRITING_TEMPLATE) value.system_prompt = P.WRITING_TEMPLATE
      else if (value.system_prompt.startsWith(P.PREVIOUS_WRITING_TEMPLATE + '\n\n【作者自定义要求】\n')) value.system_prompt = P.WRITING_TEMPLATE + value.system_prompt.slice(P.PREVIOUS_WRITING_TEMPLATE.length)
    } else if (value.writing_template_version !== 3) {
      const previous = value.system_prompt
      const legacyDefault = '使用简体中文创作小说，只输出小说正文。忠实执行完整台本，保持人物和已发生事实一致。'
      value.system_prompt = P.WRITING_TEMPLATE + (previous.trim() && previous !== legacyDefault ? '\n\n【作者自定义要求】\n' + previous : '')
    }
    value.writing_template_version = 3
    if (value.schema_version === 2 && stored) {
      db.prepare('UPDATE novel_docs SET content=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND doc_type=?').run(JSON.stringify(value), novel.id, DOC)
      bumpContextRevision(db, novel.id)
      return
    }
    const old = initial(novel, req)
    // Conflicting old edits are preserved once, disabled until the author reconciles them.
    if (stored) for (const entry of old.lorebook) {
      if (!value.lorebook.some(e => e.text.trim() === entry.text.trim())) value.lorebook.push({ ...entry, id: 'legacy-' + randomUUID(), title: '旧版待核对 · ' + entry.title, enabled: false, category: entry.category })
    }
    const snapshots = db.prepare("SELECT chapter_number,content FROM novel_doc_snapshots WHERE novel_id=? AND doc_type='progress' ORDER BY chapter_number").all(novel.id) as any[]
    let last = ''
    for (const snapshot of snapshots) {
      let memory = snapshot.content
      try {
        const state = JSON.parse(snapshot.content)
        const summary = db.prepare('SELECT content FROM novel_chapter_summaries WHERE novel_id=? AND chapter_number=?').get(novel.id, snapshot.chapter_number - 1) as any
        memory = renderProgress({ ...state, summaries: summary ? [{chapter: snapshot.chapter_number - 1, text: summary.content}] : state.summaries || [] })
      } catch { /* Keep unreadable legacy text in the history rather than dropping it. */ }
      recordMemory(novel.id, memory, 'legacy', req.user!.username, snapshot.chapter_number - 1)
      last = memory
    }
    const oldProgress = doc(novel.id, 'progress')
    if (oldProgress.trim()) { recordMemory(novel.id, oldProgress, 'legacy', req.user!.username); if (!last) last = oldProgress }
    if (!stored && last) value.memory = last
    value.schema_version = 2
    db.prepare(`INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,?,?) ON CONFLICT(novel_id,doc_type) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP`).run(novel.id, DOC, JSON.stringify(value))
    recordMemory(novel.id, value.memory, 'migration', req.user!.username, undefined, '', value.memory_through_chapter ?? (!value.memory.trim() ? 0 : undefined))
    bumpContextRevision(db, novel.id)
  })()
  return value
}
function validateSettings(value: any): Settings {
  if (!value || typeof value !== 'object') fail('写作设置无效')
  text(value.model_id, 100, '模型选择'); text(value.system_prompt, 50000, '写作要求'); text(value.memory, 100000, 'Memory')
  if (value.model_id && !getLLMConfigById(Number(value.model_id))) fail('模型配置不存在，请重新选择')
  if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) fail('温度范围 0–2')
  integer(value.max_output_tokens, 128, 32768, '输出上限'); integer(value.recent_context_chars, 0, 100000, '近期正文预算'); integer(value.context_tokens, 1024, 2000000, '上下文容量')
  if (value.memory_through_chapter !== undefined) integer(value.memory_through_chapter, 0, 999999, 'Memory 截至章节')
  if (!Array.isArray(value.lorebook) || value.lorebook.length > 500) fail('设定最多 500 条')
  const ids = new Set<string>()
  const lorebook = value.lorebook.map((e: any) => {
    text(e.id, 200, '条目 ID'); text(e.title, 500, '条目名称'); text(e.text, 50000, '设定正文'); text(e.category, 200, '分类')
    if (!e.id || ids.has(e.id)) fail('设定 ID 为空或重复'); ids.add(e.id)
    if (!Array.isArray(e.keys) || e.keys.length > 100 || e.keys.some((k: any) => typeof k !== 'string' || k.length > 500)) fail('触发词无效')
    if (typeof e.enabled !== 'boolean' || typeof e.always_on !== 'boolean') fail('设定开关无效')
    return { id: e.id, title: e.title, text: e.text, keys: e.keys, enabled: e.enabled, always_on: e.always_on, category: e.category }
  })
  const clean = { schema_version: 2, writing_template_version: 3, model_id: value.model_id, system_prompt: value.system_prompt, memory: value.memory, ...(value.memory_through_chapter === undefined ? {} : {memory_through_chapter: value.memory_through_chapter}), lorebook, temperature: value.temperature, max_output_tokens: value.max_output_tokens, recent_context_chars: value.recent_context_chars, context_tokens: value.context_tokens }
  if (JSON.stringify(clean).length > 300000) fail('写作设置过大，请精简')
  return clean
}
function chapterRow(novelId: number, idx: number) { return getDB().prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novelId, idx) as any }
function chapter(row: any, idx: number) { return { id: row?.id, raw_script: row?.outline || '', content: row?.content || '', title: row?.title || `第 ${idx} 章`, author_note: row?.author_note || '', status: row?.status || 'draft', incomplete: !!row?.writer_incomplete, last_context: row?.writer_last_context ? JSON.parse(row.writer_last_context) : null } }
function request(body: any) {
  integer(body?.chapter_idx, 1, 999999, '章节号')
  for (const [key, max] of [['raw_script', 100000], ['content', 500000], ['title', 500], ['author_note', 20000]] as const) text(body[key], max, key)
  if (body.incomplete !== undefined && typeof body.incomplete !== 'boolean') fail('正文未完成标记无效')
  const clean = { incomplete: body.incomplete ?? false, chapter_idx: body.chapter_idx, raw_script: body.raw_script, content: body.content, title: body.title, author_note: body.author_note, settings: validateSettings(body.settings), mode: body.mode || 'write' }
  if (!['write', 'continue'].includes(clean.mode)) fail('生成方式无效')
  return clean
}
function archive(novelId: number, chapterId: number, kind: string, source: any, result: any) {
  const id = randomUUID(), created_at = new Date().toISOString()
  const item = { id, kind, created_at, chapter_idx: source.chapter_idx, source, ...result }
  getDB().prepare('INSERT INTO writer_artifacts(id,novel_id,chapter_id,kind,created_at,content) VALUES (?,?,?,?,?,?)').run(id, novelId, chapterId, kind, created_at, JSON.stringify(item))
  getDB().prepare('UPDATE novel_chapters SET writer_last_context=? WHERE id=?').run(JSON.stringify(result.context), chapterId)
  return id
}
function ensureChapter(novelId: number, idx: number) {
  let row = chapterRow(novelId, idx)
  if (!row) {
    getDB().prepare('INSERT INTO novel_chapters(novel_id,chapter_number,title) VALUES (?,?,?)').run(novelId, idx, `第 ${idx} 章`)
    bumpContextRevision(getDB(), novelId)
    row = chapterRow(novelId, idx)
  }
  return row
}
async function context(novel: any, input: any, kind = input.mode) {
  const config = getLLMConfigById(Number(input.settings.model_id))
  return {...await buildModelWriterContext(getDB(), novel, input, config, kind), model: config ? publicModel(config) : null}
}
function sourceArtifact(novel: any, id: unknown, kind: string, source: any) {
  const row = typeof id === 'string' && getDB().prepare('SELECT content FROM writer_artifacts WHERE id=? AND novel_id=? AND kind=?').get(id, novel.id, kind) as any
  const item = row && JSON.parse(row.content)
  if (!item || JSON.stringify(item.source) !== JSON.stringify(source) || item.context_revision !== novel.context_revision) throw new ContextConflict('台本、正文或设定已变化，请按当前内容重新核对')
  return item
}

// Every writer route uses the original app's authentication and novel ownership check.
router.use('/:id/writer', authenticate, (req: AuthRequest, res, next) => {
  const novel = getNovelOrForbid(getDB(), req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  res.locals.novel = novel; initialize(novel, req)
  novel.context_revision = (getDB().prepare('SELECT context_revision FROM novels WHERE id=?').get(novel.id) as any).context_revision
  next()
})
const prefix = '/:id/writer'
// Same stores and model as the writing desk. Notes are derived artifacts, never Memory updates.
for (const task of ['prepare', 'check', 'repair', 'refine'] as const) router.post(prefix + '/' + task, async (req, res) => {
  let config: LLMConfig | null = null
  try {
    const n = res.locals.novel, b = request(req.body)
    if (!b.raw_script.trim()) fail('请先填写本章完整台本')
    ensureChapter(n.id, b.chapter_idx)
    n.context_revision = (getDB().prepare('SELECT context_revision FROM novels WHERE id=?').get(n.id) as any).context_revision
    config = getLLMConfigById(Number(b.settings.model_id))
    if (!config) fail('请在参数里选择已配置的创作模型')
    const selected = {...config!, temperature: .2, max_tokens: b.settings.max_output_tokens}
    let result: any
    if (task === 'prepare') {
      requireMemoryTime(b.settings, b.chapter_idx, b.mode)
      const ctx = requireWriterBudget(await context(n, b, 'prepare'))
      try {
        const completion = await invokeWithRetryResult(selected, ctx.system_prompt, ctx.user_prompt, 1, {novel_id: n.id, task: `writer:prepare:${b.chapter_idx}`})
        result = {preparation: parsePreparation(completion.text, ctx.blocks, b.raw_script, n.style_guide || ''), context: ctx}
      } catch (e: any) {
        if (!(e instanceof OutputTruncatedError) && !String(e.message).startsWith('写前核对')) throw e
        // No guessed facts or style survive a failed preparation. The deterministic time guard still applies.
        result = {preparation: {facts: [], style_rules: [], conflicts: []}, preparation_warning: '模型未能完整整理写前核对结果，本次使用原始资料与完整台本，不采用未验证的事实或文风摘要。', context: ctx}
      }
    } else if (task === 'check') {
      if (!b.content.trim()) fail('请先生成或填写正文')
      const checked = await reviewChapter(selected, {chapterNum: b.chapter_idx, content: b.content, outline: b.raw_script, worldSetting: '', characters: '', previousSummary: '', writer: {novel: n, settings: b.settings, title: b.title, author_note: b.author_note}}, {novel_id: n.id, task: `writer:check:${b.chapter_idx}`}, 1)
      const chars = Array.from(b.content.replace(/\s/gu, '')).length, range = P.chapterLengthRange(n.word_number || 2000)
      result = {...checked, length: {chars, ...range, status: chars < range.min ? 'short' : chars > range.max ? 'long' : 'within'}, context: checked.context}
    } else {
      if (!b.content.trim()) fail('请先生成或填写正文')
      if (b.incomplete) fail('正文尚未完成，请先继续写或补全，再整理局部修订建议')
      const checked = task === 'refine'
        ? await reviewChapter(selected, {chapterNum: b.chapter_idx, content: b.content, outline: b.raw_script, worldSetting: '', characters: '', previousSummary: '', writer: {novel: n, settings: b.settings, title: b.title, author_note: b.author_note}}, {novel_id: n.id, task: `writer:refine:diagnose:${b.chapter_idx}`}, 1)
        : sourceArtifact(n, req.body.check_id, 'check', b)
      const review: ReviewResult = checked.review
      if (review.raw) fail('三层诊断未返回完整结构，原稿已保留，请重试精修或核对')
      const supported = localIssues(review.issues, b.content)
      const author_decisions = review.issues.filter(i => !supported.includes(i))
      const revised: ReviseResult = supported.length ? await revisePatchwise({...selected, temperature: .3}, {content: b.content, outline: b.raw_script,
        acceptedNotes: supported.map(issueNote), rejectedNotes: author_decisions.map(issueNote),
        writer: {novel: n, settings: b.settings, chapter_idx: b.chapter_idx, title: b.title, author_note: b.author_note}}, {novel_id: n.id, task: `writer:repair:${b.chapter_idx}`}, 1)
        : {content: b.content, applied: [], failed: [], wordDelta: 0, context: checked.context}
      if (revised.raw) fail('修订建议未返回有效补丁，原稿已保留，请重试或选段修改')
      const audited = await auditRefinement(selected, n, b, revised, supported, {novel_id: n.id, task: `writer:repair:audit:${b.chapter_idx}`})
      const range = P.chapterLengthRange(n.word_number || 2000), chars = proseChars(audited.content)
      result = {...audited, diagnosis: review, author_decisions,
        length: {before: proseChars(b.content), chars, ...range, status: chars < range.min ? 'short' : chars > range.max ? 'long' : 'within'},
        contexts: {diagnosis: checked.context, revision: supported.length ? revised.context : undefined, audit: audited.audit_context},
        context: audited.context ? {...audited.context, model: publicModel(config!)} : checked.context}

    }
    assertContextRevision(getDB(), n.id, n.context_revision)
    const artifact_id = archive(n.id, ensureChapter(n.id, b.chapter_idx).id, task, b, {...result, context_revision: n.context_revision})
    res.json({...result, artifact_id})
  } catch (e: any) {
    const message = String(e.message || '写作核对失败')
    res.status(e.status || 400).json({message: config?.api_key ? message.split(config.api_key).join('[REDACTED]') : message})
  }
})

router.get(prefix + '/project', (req: AuthRequest, res) => {
  const n = res.locals.novel
  const chapters = getDB().prepare('SELECT id,chapter_number AS chapter_idx,title,status,index_status,length(trim(content))>0 AS has_content FROM novel_chapters WHERE novel_id=? ORDER BY chapter_number').all(n.id)
  res.json({ title: n.title, length_range: P.chapterLengthRange(n.word_number || 2000), settings: initialize(n, req), writing_template: P.WRITING_TEMPLATE, chapters, storage_path: '本项目 SQLite 数据库 · 与原有章节、模型和修订记录共用存储' })
})
router.get(prefix + '/models', (_req, res) => res.json({ models: getLLMConfigs().map(publicModel) }))
router.get(prefix + '/chapter/:idx', (req, res) => {
  try { const idx = integer(Number(req.params.idx), 1, 999999, '章节号'); res.json(chapter(chapterRow(res.locals.novel.id, idx), idx)) } catch (e: any) { res.status(400).json({ message: e.message }) }
})
router.post(prefix + '/settings', (req: AuthRequest, res) => {
  try {
    const n = res.locals.novel, value = validateSettings(req.body.settings)
    const current = settings(n, req)
    if (JSON.stringify(req.body.base_settings) !== JSON.stringify(current)) throw new ContextConflict('写作设置已变化，请重新载入后合并，未覆盖磁盘内容')
    getDB().transaction(() => {
      getDB().prepare(`INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,?,?) ON CONFLICT(novel_id,doc_type) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP`).run(n.id, DOC, JSON.stringify(value))
      if (value.memory !== current.memory || value.memory_through_chapter !== current.memory_through_chapter) {
        const idx = req.body.chapter_idx === undefined ? undefined : integer(req.body.chapter_idx, 1, 999999, '章节号')
        recordMemory(n.id, current.memory, 'backup', req.user!.username, idx, '修改前', current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined))
        recordMemory(n.id, value.memory, 'save', req.user!.username, idx, '', value.memory_through_chapter)
        if (value.memory_through_chapter !== undefined) invalidateWriterMemory(getDB(), n.id, value.memory_through_chapter + 1)
      }
      bumpContextRevision(getDB(), n.id)
    })()
    res.json({ settings: value })
  } catch (e: any) { res.status(e.status || 400).json({ message: e.message }) }
})
router.get(prefix + '/lore-source', (req: AuthRequest, res) => res.json({ lorebook: settings(res.locals.novel, req).lorebook }))
router.get(prefix + '/memory/history', (_req, res) => {
  const db = getDB(), id = res.locals.novel.id
  res.json({items: db.prepare('SELECT id,chapter_number,title,kind,created_by,created_at,memory_through_chapter,source_digest,invalidated_at FROM writer_memory_history WHERE novel_id=? ORDER BY id DESC').all(id).map(row => memoryVersionStatus(db, id, row))})
})
router.get(prefix + '/memory/history/:version', (req, res) => {
  const row = getDB().prepare('SELECT * FROM writer_memory_history WHERE novel_id=? AND id=?').get(res.locals.novel.id, req.params.version)
  if (!row) return res.status(404).json({message: '记忆历史不存在'})
  res.json({...memoryVersionStatus(getDB(), res.locals.novel.id, row), context_revision: res.locals.novel.context_revision})
})
router.get(prefix + '/memory/before/:idx', (req, res) => {
  try {
    const idx = integer(Number(req.params.idx), 1, 999999, '章节号'), n = res.locals.novel
    res.json({...memoryBeforeChapter(getDB(), n.id, idx), target_chapter: idx, context_revision: n.context_revision})
  } catch (e: any) { res.status(400).json({message: e.message}) }
})
router.post(prefix + '/memory/restore', (req: AuthRequest, res) => {
  try {
    const db = getDB(), n = res.locals.novel, current = settings(n, req), edited = validateSettings(req.body.settings)
    assertContextRevision(db, n.id, req.body.context_revision)
    if (JSON.stringify(req.body.base_settings) !== JSON.stringify(current)) throw new ContextConflict('当前 Memory 或设置已变化，请重新预览后恢复')
    let candidate: any
    if (req.body.version_id === null && req.body.target_chapter === 1) candidate = memoryBeforeChapter(db, n.id, 1)
    else candidate = db.prepare('SELECT * FROM writer_memory_history WHERE novel_id=? AND id=?').get(n.id, integer(req.body.version_id, 1, Number.MAX_SAFE_INTEGER, '记忆版本'))
    if (!candidate) fail('记忆历史不存在或不属于本书')
    if (candidate.id !== null) candidate = memoryVersionStatus(db, n.id, candidate)
    if (!candidate.restorable) fail(candidate.restore_reason)
    if (req.body.target_chapter !== undefined && candidate.memory_through_chapter !== integer(req.body.target_chapter, 1, 999999, '章节号') - 1) fail('快照与待重写章节不匹配，请重新预览')
    const next = validateSettings({...edited, memory: candidate.memory, memory_through_chapter: candidate.memory_through_chapter})
    db.transaction(() => {
      recordMemory(n.id, current.memory, 'backup', req.user!.username, undefined, '恢复前', current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined))
      if (edited.memory !== current.memory || edited.memory_through_chapter !== current.memory_through_chapter) recordMemory(n.id, edited.memory, 'backup', req.user!.username, undefined, '恢复前未保存的编辑', edited.memory_through_chapter)
      db.prepare('UPDATE novel_docs SET content=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND doc_type=?').run(JSON.stringify(next), n.id, DOC)
      recordMemory(n.id, next.memory, 'restore', req.user!.username, undefined, '从历史恢复', next.memory_through_chapter)
      bumpContextRevision(db, n.id)
    })()
    res.json({settings: next, message: 'Memory 已恢复，原版本保留在历史中；章节正文未改动'})
  } catch (e: any) { res.status(e.status || 400).json({message: e.message}) }
})
router.post(prefix + '/chapter/:idx/finalize', (req: AuthRequest, res) => {
  try {
    const db = getDB(), n = res.locals.novel, idx = integer(Number(req.params.idx), 1, 999999, '章节号'), row = chapterRow(n.id, idx)
    if (!row?.content?.trim()) fail('请先保存本章正文')
    if (row.writer_incomplete) fail('本章正文曾达到输出上限，请先继续写或手工补全并保存，再定稿')
    if (req.body.confirmed !== true) fail('请确认已核对本章正文和 Memory')
    const current = settings(n, req)
    if (JSON.stringify(req.body.base_settings) !== JSON.stringify(current) || !req.body.base_chapter || ['content','title','raw_script','author_note'].some(k => req.body.base_chapter[k] !== (chapter(row, idx) as any)[k])) throw new ContextConflict('正文或 Memory 已变化，请重新核对后定稿')
    if (req.body.base_chapter.incomplete !== undefined && req.body.base_chapter.incomplete !== !!row.writer_incomplete) throw new ContextConflict('正文完成状态已变化，请重新核对后定稿')
    const memory = req.body.memory === undefined ? current.memory : text(req.body.memory, 100000, 'Memory')
    const next = validateSettings({...current, memory, memory_through_chapter: idx})
    const previous = db.prepare("SELECT memory,title FROM writer_memory_history WHERE novel_id=? AND chapter_number=? AND kind='finalize' ORDER BY id DESC LIMIT 1").get(n.id, idx) as any
    if (row.status === 'finalized' && memory === current.memory && current.memory_through_chapter === idx && previous?.memory === memory && previous?.title === row.title) return res.json({message: '本章及当前 Memory 已定稿', settings: next, chapter: chapter(row, idx)})
    db.transaction(() => {
      recordMemory(n.id, current.memory, 'backup', req.user!.username, idx, '定稿前', current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined))
      invalidateWriterMemory(db, n.id, idx + 1)
      if (JSON.stringify(next) !== JSON.stringify(current)) db.prepare('UPDATE novel_docs SET content=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND doc_type=?').run(JSON.stringify(next), n.id, DOC)
      db.prepare("UPDATE novel_chapters SET status='finalized',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id)
      recordMemory(n.id, memory, 'finalize', req.user!.username, idx, row.title, idx)
      db.prepare("UPDATE novel_chapters SET status='needs_review' WHERE novel_id=? AND chapter_number>? AND status='finalized'").run(n.id, idx)
      bumpContextRevision(db, n.id)
    })()
    res.json({message: '章节已定稿，Memory 已更新并保存为历史版本', settings: next, chapter: chapter(chapterRow(n.id, idx), idx)})
  } catch (e: any) { res.status(e.status || 400).json({message: e.message}) }
})
router.post(prefix + '/save', (req, res) => {
  try {
    const b = req.body, n = res.locals.novel, idx = integer(b.chapter_idx, 1, 999999, '章节号'), current = chapter(chapterRow(n.id, idx), idx)
    for (const [k, max] of [['content', 500000], ['raw_script', 100000], ['title', 500], ['author_note', 20000]] as const) text(b[k], max, k)
    if (!b.base_chapter || ['content', 'raw_script', 'title', 'author_note'].some(k => b.base_chapter[k] !== (current as any)[k])) throw new ContextConflict('章节已被其他页面修改，请重新载入后合并，当前输入未覆盖它')
    if (b.incomplete !== undefined && typeof b.incomplete !== 'boolean') fail('正文未完成标记无效')
    if (b.base_chapter.incomplete !== undefined && b.base_chapter.incomplete !== current.incomplete) throw new ContextConflict('正文完成状态已变化，请重新载入后合并')
    if (b.last_context && JSON.stringify(b.last_context).length > 2000000) fail('上下文记录过大')
    getDB().transaction(() => {
      const row = ensureChapter(n.id, idx)
      if (row.title !== b.title || row.author_note !== b.author_note) bumpContextRevision(getDB(), n.id)
      const incomplete = b.incomplete ?? current.incomplete
      getDB().prepare('UPDATE novel_chapters SET title=?,author_note=?,writer_last_context=?,writer_incomplete=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.title, b.author_note, JSON.stringify(b.last_context || null), Number(incomplete), row.id)
      if (incomplete !== current.incomplete) {
        getDB().prepare("UPDATE novel_chapters SET status='draft' WHERE id=?").run(row.id)
        bumpContextRevision(getDB(), n.id)
      }
      writeOutline(row, b.raw_script, { user: (req as AuthRequest).user!.username, note: '写作台保存前' })
      saveChapterContent(getDB(), n.id, row, b.content, '写作台保存前')
    })()
    res.json(chapter(chapterRow(n.id, idx), idx))
  } catch (e: any) { res.status(e.status || 400).json({ message: e.message }) }
})
router.post(prefix + '/context', async (req, res) => {
  try { res.json(await context(res.locals.novel, request(req.body))) } catch (e: any) { res.status(400).json({ message: e.message }) }
})
for (const [path, kind] of [['/generate', 'generate'], ['/revise', 'revise'], ['/memory/suggest', 'memory'], ['/lore/polish', 'lore']]) {
  router.post(prefix + path, async (req, res) => {
    let config: LLMConfig | null = null
    try {
      const n = res.locals.novel, b = request(req.body), task = kind === 'generate' ? b.mode : kind
      if (task === 'write' && !b.raw_script.trim()) fail('请先填写完整台本')
      if (['continue', 'memory'].includes(task) && !b.content.trim()) fail('请先提供正文')
      if (kind === 'generate') requireMemoryTime(b.settings, b.chapter_idx, b.mode)
      const input: any = { ...b }
      if (task === 'lore') {
        input.lore_entry = validateSettings({...b.settings, lorebook: [req.body.lore_entry]}).lorebook[0]
        if (!input.lore_entry.title.trim() || !input.lore_entry.text.trim()) fail('请填写条目名称和设定正文')
      }
      if (task === 'revise') {
        for (const [key, max] of [['before', 500000], ['selected', 100000], ['after', 500000], ['instruction', 20000]] as const) input[key] = text(req.body[key], max, key)
        if (!input.selected.trim() || !input.instruction.trim()) fail('请选择正文并填写修改要求')
        if (input.before + input.selected + input.after !== input.content) throw new ContextConflict('选区已变化，请重新选择')
      }
      if (task === 'memory' && b.content !== chapterRow(n.id, b.chapter_idx)?.content) throw new ContextConflict('请先保存并确认本章正文，再整理记忆')
      if (task === 'memory') requireMemoryTime(b.settings, b.chapter_idx, 'write')
      config = getLLMConfigById(Number(b.settings.model_id))
      if (!config) fail('请在参数里选择已配置的创作模型')
      if (kind === 'generate' && req.body.prepared_id !== undefined) {
        const prepared = sourceArtifact(n, req.body.prepared_id, 'prepare', b)
        if (prepared.preparation.conflicts.length) fail('写前发现材料冲突，请先核对 Memory、台本或设定，再生成正文')
        input.preparation = prepared.preparation
        input.preparation_warning = prepared.preparation_warning
      }
      const ctx = requireWriterBudget(await context(n, input, task))
      if (input.preparation_warning) ctx.warnings.push(input.preparation_warning)
      const completion = await invokeWithRetryResult({ ...config!, temperature: b.settings.temperature, max_tokens: b.settings.max_output_tokens }, ctx.system_prompt, ctx.user_prompt, 1, { novel_id: n.id, task: `writer:${task}:${b.chapter_idx}` }, kind === 'generate')
      const output = completion.text
      if (!output.trim() || output.includes('<think>')) fail('模型未返回有效正文')
      if (task === 'lore') {
        if (output.length > 50000) fail('整理结果超过设定正文 50000 字符上限，请缩短条目后重试')
        res.json({ text: output, context: ctx }); return
      }
      const result = task === 'memory' ? { memory: output, context: ctx } : task === 'revise' ? { replacement: output, context: ctx } : { content: task === 'continue' ? b.content + '\n\n' + output : output, context: ctx, incomplete: completion.incomplete, finish_reason: completion.finish_reason }
      const artifact_id = getDB().transaction(() => archive(n.id, ensureChapter(n.id, b.chapter_idx).id, task, input, result))()
      res.json({ ...result, artifact_id })
    } catch (e: any) { const message = String(e.message || '模型调用失败'); res.status(e.status || 400).json({ message: config?.api_key ? message.split(config.api_key).join('[REDACTED]') : message }) }
  })
}
router.get(prefix + '/chapter/:idx/history', (req, res) => {
  const rows = getDB().prepare(`SELECT a.id,a.kind,a.created_at FROM writer_artifacts a JOIN novel_chapters c ON c.id=a.chapter_id WHERE a.novel_id=? AND c.chapter_number=? ORDER BY a.created_at DESC,a.id DESC`).all(res.locals.novel.id, Number(req.params.idx))
  res.json({ items: rows })
})
router.get(prefix + '/chapter/:idx/history/:artifact', (req, res) => {
  const row = getDB().prepare(`SELECT a.content FROM writer_artifacts a JOIN novel_chapters c ON c.id=a.chapter_id WHERE a.novel_id=? AND c.chapter_number=? AND a.id=?`).get(res.locals.novel.id, Number(req.params.idx), req.params.artifact) as any
  if (!row) return res.status(404).json({ message: '生成记录不存在' }); res.json(JSON.parse(row.content))
})
router.get(prefix + '/download', (req, res) => {
  const n = res.locals.novel, format = String(req.query.format || 'txt')
  if (!['txt', 'md', 'json'].includes(format)) return res.status(400).json({ message: '导出格式无效' })
  const db = getDB(), rows = db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? ORDER BY chapter_number').all(n.id) as any[]
  res.attachment(`mountain-view-${n.id}.${format}`)
  if (format === 'json') return res.type('json').send(JSON.stringify({ format: 'mountain-view-writing-backup-v1', novel: n, docs: db.prepare('SELECT doc_type,content FROM novel_docs WHERE novel_id=?').all(n.id), chapters: rows,
    memory_history: db.prepare('SELECT * FROM writer_memory_history WHERE novel_id=? ORDER BY id').all(n.id),
    writer_artifacts: db.prepare('SELECT * FROM writer_artifacts WHERE novel_id=?').all(n.id),
    chapter_revisions: db.prepare('SELECT r.* FROM chapter_revisions r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?').all(n.id),
    outline_revisions: db.prepare('SELECT r.* FROM chapter_outline_revisions r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?').all(n.id),
    progress_snapshots: db.prepare('SELECT * FROM novel_doc_snapshots WHERE novel_id=?').all(n.id),
    chapter_summaries: db.prepare('SELECT * FROM novel_chapter_summaries WHERE novel_id=?').all(n.id),
    memory_reviews: db.prepare('SELECT r.* FROM novel_memory_reviews r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?').all(n.id),
    outline_reviews: db.prepare('SELECT r.* FROM chapter_outline_reviews r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?').all(n.id),
    models: getLLMConfigs().map(publicModel) }, null, 2))
  const parts = rows.filter(c => c.content.trim()).map(c => {
    const title = c.title.replace(/^第\s*\d+\s*章\s*/, '').trim()
    return `${format === 'md' ? '# ' : ''}第 ${c.chapter_number} 章${title ? ' ' + title : ''}\n\n${c.content.trim()}`
  })
  if (!parts.length) return res.status(400).json({ message: '请先保存至少一章正文' })
  res.type('text/plain; charset=utf-8').send('\ufeff' + n.title + '\n\n' + parts.join('\n\n\n'))
})
export default router
