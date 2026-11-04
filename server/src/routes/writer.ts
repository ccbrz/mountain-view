/** Author-controlled writing desk. Uses the existing accounts, models, chapters and revision store. */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { getLLMConfigs, getLLMConfigById, LLMConfig, redactKey } from '../llm/config'
import { invokeWithRetryResult } from '../llm/invoke'
import { getNovelOrForbid, saveChapterContent } from './shared'
import { writeOutline } from '../llm/outline-review'
import { assertContextRevision, bumpContextRevision, ContextConflict } from '../llm/revision'
import * as P from '../llm/prompts'
import { buildModelWriterContext, requireWriterBudget } from '../llm/writer-context'
import { WRITER_DOC as DOC, WriterSettings as Settings, writerSettings } from '../llm/writer-state'
import { parsePreparation, requireMemoryTime, outlineBeats } from '../llm/writer-preparation'
import {
  COVERAGE_SYSTEM,
  coverageInput,
  endsMidSentence,
  joinSegments,
  MAX_SEGMENTS,
  parseCoverage,
  stripProseMarkers,
} from '../llm/segmented-generation'
import { reviewChapter, ReviewResult } from '../llm/review'
import { revisePatchwise, ReviseResult } from '../llm/revise'
import { auditRefinement, localIssues, issueNote, proseChars } from '../llm/writer-refinement'
import {
  recordWriterMemory,
  memoryVersionStatus,
  memoryBeforeChapter,
  invalidateWriterMemory,
} from '../llm/writer-memory'
import { OutputTruncatedError, isNovelAIKayra } from '../llm/adapter'
import { addLLMCallLog, updateLLMCallLog } from '../llm/logstore'
import {
  generateNovelAIImage,
  isImageModel,
  PORTRAIT_TAG_SYSTEM,
  portraitTagInput,
  QUALITY_TAGS,
  sanitizeTags,
  SCENE_TAG_SYSTEM,
  sceneTagInput,
  isCharacterEntry,
  loreSceneInput,
} from '../llm/lore-portrait'

const router = Router()
const fail = (text: string) => {
  throw new Error(text)
}
const text = (value: any, max: number, label: string): string =>
  typeof value === 'string' && value.length <= max ? value : fail(`${label}必须是文本，最多 ${max} 字符`)
function integer(value: any, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}范围 ${min}–${max}`)
  return value
}
const publicModel = (c: LLMConfig) => ({
  id: String(c.id),
  name: c.name,
  provider: c.interface_format,
  model: c.model_name,
  base_url: c.base_url,
  has_api_key: !!c.api_key,
})
function recordMemory(
  novelId: number,
  memory: string,
  kind: string,
  user: string,
  chapter?: number,
  title = '',
  through?: number,
) {
  recordWriterMemory(getDB(), novelId, memory, kind, user, chapter, title, through)
}
const settings = (novel: any): Settings => writerSettings(getDB(), novel.id)
function validateSettings(value: any): Settings {
  if (!value || typeof value !== 'object') fail('写作设置无效')
  text(value.model_id, 100, '模型选择')
  text(value.system_prompt, 50000, '写作要求')
  text(value.memory, 100000, 'Memory')
  const model = (id: unknown, label: string, image: boolean) => {
    if (id === undefined || id === '') return
    const config = getLLMConfigById(Number(text(id, 100, label)))
    if (!config) fail(`${label}不存在，请重新选择`)
    if (isImageModel(config!) !== image) fail(image ? `${label}必须是生图模型` : `${label}不能使用生图模型`)
  }
  model(value.model_id, '创作模型', false)
  model(value.lore_model_id, '设定生成模型', false)
  model(value.image_model_id, '人物形象模型', true)
  if (
    typeof value.temperature !== 'number' ||
    !Number.isFinite(value.temperature) ||
    value.temperature < 0 ||
    value.temperature > 2
  )
    fail('温度范围 0–2')
  integer(value.max_output_tokens, 128, 32768, '输出上限')
  integer(value.recent_context_chars, 0, 100000, '近期正文预算')
  integer(value.context_tokens, 1024, 2000000, '上下文容量')
  if (value.memory_through_chapter !== undefined) integer(value.memory_through_chapter, 0, 999999, 'Memory 截至章节')
  if (!Array.isArray(value.lorebook) || value.lorebook.length > 500) fail('设定最多 500 条')
  const ids = new Set<string>()
  const lorebook = value.lorebook.map((e: any) => {
    text(e.id, 200, '条目 ID')
    text(e.title, 500, '条目名称')
    text(e.text, 50000, '设定正文')
    text(e.category, 200, '分类')
    if (!e.id || ids.has(e.id)) fail('设定 ID 为空或重复')
    ids.add(e.id)
    if (
      !Array.isArray(e.keys) ||
      e.keys.length > 100 ||
      e.keys.some((k: any) => typeof k !== 'string' || k.length > 500)
    )
      fail('触发词无效')
    if (typeof e.enabled !== 'boolean' || typeof e.always_on !== 'boolean') fail('设定开关无效')
    return {
      id: e.id,
      title: e.title,
      text: e.text,
      keys: e.keys,
      enabled: e.enabled,
      always_on: e.always_on,
      category: e.category,
    }
  })
  const clean = {
    model_id: value.model_id,
    ...(value.lore_model_id ? { lore_model_id: value.lore_model_id } : {}),
    ...(value.image_model_id ? { image_model_id: value.image_model_id } : {}),
    system_prompt: value.system_prompt,
    memory: value.memory,
    ...(value.memory_through_chapter === undefined ? {} : { memory_through_chapter: value.memory_through_chapter }),
    lorebook,
    temperature: value.temperature,
    max_output_tokens: value.max_output_tokens,
    recent_context_chars: value.recent_context_chars,
    context_tokens: value.context_tokens,
  }
  if (JSON.stringify(clean).length > 300000) fail('写作设置过大，请精简')
  return clean
}
function chapterRow(novelId: number, idx: number) {
  return getDB().prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novelId, idx) as any
}
function chapter(row: any, idx: number) {
  return {
    id: row?.id,
    raw_script: row?.outline || '',
    content: row?.content || '',
    title: row?.title || `第 ${idx} 章`,
    author_note: row?.author_note || '',
    status: row?.status || 'draft',
    incomplete: !!row?.writer_incomplete,
    last_context: row?.writer_last_context ? JSON.parse(row.writer_last_context) : null,
  }
}
function request(body: any) {
  integer(body?.chapter_idx, 1, 999999, '章节号')
  for (const [key, max] of [
    ['raw_script', 100000],
    ['content', 500000],
    ['title', 500],
    ['author_note', 20000],
  ] as const)
    text(body[key], max, key)
  if (body.incomplete !== undefined && typeof body.incomplete !== 'boolean') fail('正文未完成标记无效')
  const clean = {
    incomplete: body.incomplete ?? false,
    chapter_idx: body.chapter_idx,
    raw_script: body.raw_script,
    content: body.content,
    title: body.title,
    author_note: body.author_note,
    settings: validateSettings(body.settings),
    mode: body.mode || 'write',
  }
  if (!['write', 'continue'].includes(clean.mode)) fail('生成方式无效')
  return clean
}
function archive(novelId: number, chapterId: number, kind: string, source: any, result: any) {
  const id = randomUUID(),
    created_at = new Date().toISOString()
  const item = { id, kind, created_at, chapter_idx: source.chapter_idx, source, ...result }
  getDB()
    .prepare('INSERT INTO writer_artifacts(id,novel_id,chapter_id,kind,created_at,content) VALUES (?,?,?,?,?,?)')
    .run(id, novelId, chapterId, kind, created_at, JSON.stringify(item))
  getDB()
    .prepare('UPDATE novel_chapters SET writer_last_context=? WHERE id=?')
    .run(JSON.stringify(result.context), chapterId)
  return id
}
function ensureChapter(novelId: number, idx: number) {
  let row = chapterRow(novelId, idx)
  if (!row) {
    getDB()
      .prepare('INSERT INTO novel_chapters(novel_id,chapter_number,title) VALUES (?,?,?)')
      .run(novelId, idx, `第 ${idx} 章`)
    bumpContextRevision(getDB(), novelId)
    row = chapterRow(novelId, idx)
  }
  return row
}
async function context(novel: any, input: any, kind = input.mode) {
  const config = getLLMConfigById(
    Number(kind === 'lore' ? input.settings.lore_model_id || input.settings.model_id : input.settings.model_id),
  )
  if (kind === 'lore' && config) {
    const kayra = isNovelAIKayra(config)
    input = {
      ...input,
      settings: {
        ...input.settings,
        max_output_tokens: kayra
          ? Math.min(config.max_tokens, 2000)
          : input.settings.lore_model_id
            ? Math.min(config.max_tokens, input.settings.max_output_tokens)
            : input.settings.max_output_tokens,
        context_tokens: kayra ? Math.min(input.settings.context_tokens, 8192) : input.settings.context_tokens,
      },
    }
  }
  return {
    ...(await buildModelWriterContext(getDB(), novel, input, config, kind)),
    model: config ? publicModel(config) : null,
  }
}
function sourceArtifact(novel: any, id: unknown, kind: string, source: any) {
  const row =
    typeof id === 'string' &&
    (getDB()
      .prepare('SELECT content FROM writer_artifacts WHERE id=? AND novel_id=? AND kind=?')
      .get(id, novel.id, kind) as any)
  const item = row && JSON.parse(row.content)
  if (
    !item ||
    JSON.stringify(item.source) !== JSON.stringify(source) ||
    item.context_revision !== novel.context_revision
  )
    throw new ContextConflict('台本、正文或设定已变化，请按当前内容重新核对')
  return item
}

// Every writer route requires authentication and novel ownership.
router.use('/:id/writer', authenticate, (req: AuthRequest, res, next) => {
  const novel = getNovelOrForbid(getDB(), req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  res.locals.novel = novel
  next()
})
const prefix = '/:id/writer'
// Same stores and model as the writing desk. Notes are derived artifacts, never Memory updates.
for (const task of ['prepare', 'check', 'repair', 'refine'] as const)
  router.post(prefix + '/' + task, async (req, res) => {
    let config: LLMConfig | null = null
    try {
      const n = res.locals.novel,
        b = request(req.body)
      if (!b.raw_script.trim()) fail('请先填写本章完整台本')
      ensureChapter(n.id, b.chapter_idx)
      n.context_revision = (
        getDB().prepare('SELECT context_revision FROM novels WHERE id=?').get(n.id) as any
      ).context_revision
      config = getLLMConfigById(Number(b.settings.model_id))
      if (!config) fail('请在参数里选择已配置的创作模型')
      const selected = { ...config!, temperature: 0.2, max_tokens: b.settings.max_output_tokens }
      let result: any
      if (task === 'prepare') {
        requireMemoryTime(b.settings, b.chapter_idx, b.mode)
        const ctx = requireWriterBudget(await context(n, b, 'prepare'))
        try {
          const completion = await invokeWithRetryResult(selected, ctx.system_prompt, ctx.user_prompt, 1, {
            novel_id: n.id,
            task: `writer:prepare:${b.chapter_idx}`,
          })
          result = {
            preparation: parsePreparation(completion.text, ctx.blocks, b.raw_script, n.style_guide || ''),
            context: ctx,
          }
        } catch (e: any) {
          if (!(e instanceof OutputTruncatedError) && !String(e.message).startsWith('写前核对')) throw e
          // No guessed facts or style survive a failed preparation. The deterministic time guard still applies.
          result = {
            preparation: { facts: [], style_rules: [], conflicts: [] },
            preparation_warning:
              '模型未能完整整理写前核对结果，本次使用原始资料与完整台本，不采用未验证的事实或文风摘要。',
            context: ctx,
          }
        }
      } else if (task === 'check') {
        if (!b.content.trim()) fail('请先生成或填写正文')
        const checked = await reviewChapter(
          selected,
          {
            chapterNum: b.chapter_idx,
            content: b.content,
            outline: b.raw_script,
            writer: { novel: n, settings: b.settings, title: b.title, author_note: b.author_note },
          },
          { novel_id: n.id, task: `writer:check:${b.chapter_idx}` },
          1,
        )
        const chars = Array.from(b.content.replace(/\s/gu, '')).length,
          range = P.chapterLengthRange(n.word_number || 2000)
        result = {
          ...checked,
          length: { chars, ...range, status: chars < range.min ? 'short' : chars > range.max ? 'long' : 'within' },
          context: checked.context,
        }
      } else {
        if (!b.content.trim()) fail('请先生成或填写正文')
        if (b.incomplete) fail('正文尚未完成，请先继续写或补全，再整理局部修订建议')
        const checked =
          task === 'refine'
            ? await reviewChapter(
                selected,
                {
                  chapterNum: b.chapter_idx,
                  content: b.content,
                  outline: b.raw_script,
                  writer: { novel: n, settings: b.settings, title: b.title, author_note: b.author_note },
                },
                { novel_id: n.id, task: `writer:refine:diagnose:${b.chapter_idx}` },
                1,
              )
            : sourceArtifact(n, req.body.check_id, 'check', b)
        const review: ReviewResult = checked.review
        if (review.raw) fail('三层诊断未返回完整结构，原稿已保留，请重试精修或核对')
        const supported = localIssues(review.issues, b.content)
        const author_decisions = review.issues.filter(i => !supported.includes(i))
        const revised: ReviseResult = supported.length
          ? await revisePatchwise(
              { ...selected, temperature: 0.3 },
              {
                content: b.content,
                outline: b.raw_script,
                acceptedNotes: supported.map(issueNote),
                rejectedNotes: author_decisions.map(issueNote),
                writer: {
                  novel: n,
                  settings: b.settings,
                  chapter_idx: b.chapter_idx,
                  title: b.title,
                  author_note: b.author_note,
                },
              },
              { novel_id: n.id, task: `writer:repair:${b.chapter_idx}` },
              1,
            )
          : { content: b.content, applied: [], failed: [], wordDelta: 0, context: checked.context }
        if (revised.raw) fail('修订建议未返回有效补丁，原稿已保留，请重试或选段修改')
        const audited = await auditRefinement(selected, n, b, revised, supported, {
          novel_id: n.id,
          task: `writer:repair:audit:${b.chapter_idx}`,
        })
        const range = P.chapterLengthRange(n.word_number || 2000),
          chars = proseChars(audited.content)
        result = {
          ...audited,
          diagnosis: review,
          author_decisions,
          length: {
            before: proseChars(b.content),
            chars,
            ...range,
            status: chars < range.min ? 'short' : chars > range.max ? 'long' : 'within',
          },
          contexts: {
            diagnosis: checked.context,
            revision: supported.length ? revised.context : undefined,
            audit: audited.audit_context,
          },
          context: audited.context ? { ...audited.context, model: publicModel(config!) } : checked.context,
        }
      }
      assertContextRevision(getDB(), n.id, n.context_revision)
      const artifact_id = archive(n.id, ensureChapter(n.id, b.chapter_idx).id, task, b, {
        ...result,
        context_revision: n.context_revision,
      })
      res.json({ ...result, artifact_id })
    } catch (e: any) {
      const message = String(e.message || '写作核对失败')
      res.status(e.status || 400).json({ message: redactKey(message, config) })
    }
  })

router.get(prefix + '/project', (req: AuthRequest, res) => {
  const n = res.locals.novel
  const chapters = getDB()
    .prepare(
      'SELECT id,chapter_number AS chapter_idx,title,status,word_count,length(trim(content))>0 AS has_content FROM novel_chapters WHERE novel_id=? ORDER BY chapter_number',
    )
    .all(n.id)
  res.json({
    title: n.title,
    length_range: P.chapterLengthRange(n.word_number || 2000),
    settings: settings(n),
    writing_template: P.WRITING_TEMPLATE,
    chapters,
  })
})
router.get(prefix + '/models', (_req, res) => res.json({ models: getLLMConfigs().map(publicModel) }))
router.get(prefix + '/chapter/:idx', (req, res) => {
  try {
    const idx = integer(Number(req.params.idx), 1, 999999, '章节号')
    res.json(chapter(chapterRow(res.locals.novel.id, idx), idx))
  } catch (e: any) {
    res.status(400).json({ message: e.message })
  }
})
router.post(prefix + '/settings', (req: AuthRequest, res) => {
  try {
    const n = res.locals.novel,
      value = validateSettings(req.body.settings)
    const current = settings(n)
    if (JSON.stringify(req.body.base_settings) !== JSON.stringify(current))
      throw new ContextConflict('写作设置已变化，请重新载入后合并，未覆盖磁盘内容')
    getDB().transaction(() => {
      getDB()
        .prepare(
          `INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,?,?) ON CONFLICT(novel_id,doc_type) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP`,
        )
        .run(n.id, DOC, JSON.stringify(value))
      if (value.memory !== current.memory || value.memory_through_chapter !== current.memory_through_chapter) {
        const idx = req.body.chapter_idx === undefined ? undefined : integer(req.body.chapter_idx, 1, 999999, '章节号')
        recordMemory(
          n.id,
          current.memory,
          'backup',
          req.user!.username,
          idx,
          '修改前',
          current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined),
        )
        recordMemory(n.id, value.memory, 'save', req.user!.username, idx, '', value.memory_through_chapter)
        if (value.memory_through_chapter !== undefined)
          invalidateWriterMemory(getDB(), n.id, value.memory_through_chapter + 1)
      }
      bumpContextRevision(getDB(), n.id)
    })()
    res.json({ settings: value })
  } catch (e: any) {
    res.status(e.status || 400).json({ message: e.message })
  }
})
router.get(prefix + '/memory/history', (_req, res) => {
  const db = getDB(),
    id = res.locals.novel.id
  res.json({
    items: db
      .prepare(
        'SELECT id,chapter_number,title,kind,created_by,created_at,memory_through_chapter,source_digest,invalidated_at FROM writer_memory_history WHERE novel_id=? ORDER BY id DESC',
      )
      .all(id)
      .map(row => memoryVersionStatus(db, id, row)),
  })
})
router.get(prefix + '/memory/history/:version', (req, res) => {
  const row = getDB()
    .prepare('SELECT * FROM writer_memory_history WHERE novel_id=? AND id=?')
    .get(res.locals.novel.id, req.params.version)
  if (!row) return res.status(404).json({ message: '记忆历史不存在' })
  res.json({
    ...memoryVersionStatus(getDB(), res.locals.novel.id, row),
    context_revision: res.locals.novel.context_revision,
  })
})
router.get(prefix + '/memory/before/:idx', (req, res) => {
  try {
    const idx = integer(Number(req.params.idx), 1, 999999, '章节号'),
      n = res.locals.novel
    res.json({ ...memoryBeforeChapter(getDB(), n.id, idx), target_chapter: idx, context_revision: n.context_revision })
  } catch (e: any) {
    res.status(400).json({ message: e.message })
  }
})
router.post(prefix + '/memory/restore', (req: AuthRequest, res) => {
  try {
    const db = getDB(),
      n = res.locals.novel,
      current = settings(n),
      edited = validateSettings(req.body.settings)
    assertContextRevision(db, n.id, req.body.context_revision)
    if (JSON.stringify(req.body.base_settings) !== JSON.stringify(current))
      throw new ContextConflict('当前 Memory 或设置已变化，请重新预览后恢复')
    let candidate: any
    if (req.body.version_id === null && req.body.target_chapter === 1) candidate = memoryBeforeChapter(db, n.id, 1)
    else
      candidate = db
        .prepare('SELECT * FROM writer_memory_history WHERE novel_id=? AND id=?')
        .get(n.id, integer(req.body.version_id, 1, Number.MAX_SAFE_INTEGER, '记忆版本'))
    if (!candidate) fail('记忆历史不存在或不属于本书')
    if (candidate.id !== null) candidate = memoryVersionStatus(db, n.id, candidate)
    if (!candidate.restorable) fail(candidate.restore_reason)
    if (
      req.body.target_chapter !== undefined &&
      candidate.memory_through_chapter !== integer(req.body.target_chapter, 1, 999999, '章节号') - 1
    )
      fail('快照与待重写章节不匹配，请重新预览')
    const next = validateSettings({
      ...edited,
      memory: candidate.memory,
      memory_through_chapter: candidate.memory_through_chapter,
    })
    db.transaction(() => {
      recordMemory(
        n.id,
        current.memory,
        'backup',
        req.user!.username,
        undefined,
        '恢复前',
        current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined),
      )
      if (edited.memory !== current.memory || edited.memory_through_chapter !== current.memory_through_chapter)
        recordMemory(
          n.id,
          edited.memory,
          'backup',
          req.user!.username,
          undefined,
          '恢复前未保存的编辑',
          edited.memory_through_chapter,
        )
      db.prepare('UPDATE novel_docs SET content=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND doc_type=?').run(
        JSON.stringify(next),
        n.id,
        DOC,
      )
      recordMemory(
        n.id,
        next.memory,
        'restore',
        req.user!.username,
        undefined,
        '从历史恢复',
        next.memory_through_chapter,
      )
      bumpContextRevision(db, n.id)
    })()
    res.json({ settings: next, message: 'Memory 已恢复，原版本保留在历史中；章节正文未改动' })
  } catch (e: any) {
    res.status(e.status || 400).json({ message: e.message })
  }
})
router.post(prefix + '/chapter/:idx/finalize', (req: AuthRequest, res) => {
  try {
    const db = getDB(),
      n = res.locals.novel,
      idx = integer(Number(req.params.idx), 1, 999999, '章节号'),
      row = chapterRow(n.id, idx)
    if (!row?.content?.trim()) fail('请先保存本章正文')
    if (row.writer_incomplete) fail('本章正文曾达到输出上限，请先继续写或手工补全并保存，再定稿')
    if (req.body.confirmed !== true) fail('请确认已核对本章正文和 Memory')
    const current = settings(n)
    if (
      JSON.stringify(req.body.base_settings) !== JSON.stringify(current) ||
      !req.body.base_chapter ||
      ['content', 'title', 'raw_script', 'author_note'].some(
        k => req.body.base_chapter[k] !== (chapter(row, idx) as any)[k],
      )
    )
      throw new ContextConflict('正文或 Memory 已变化，请重新核对后定稿')
    if (req.body.base_chapter.incomplete !== undefined && req.body.base_chapter.incomplete !== !!row.writer_incomplete)
      throw new ContextConflict('正文完成状态已变化，请重新核对后定稿')
    const memory = req.body.memory === undefined ? current.memory : text(req.body.memory, 100000, 'Memory')
    const next = validateSettings({ ...current, memory, memory_through_chapter: idx })
    const previous = db
      .prepare(
        "SELECT memory,title FROM writer_memory_history WHERE novel_id=? AND chapter_number=? AND kind='finalize' ORDER BY id DESC LIMIT 1",
      )
      .get(n.id, idx) as any
    if (
      row.status === 'finalized' &&
      memory === current.memory &&
      current.memory_through_chapter === idx &&
      previous?.memory === memory &&
      previous?.title === row.title
    )
      return res.json({ message: '本章及当前 Memory 已定稿', settings: next, chapter: chapter(row, idx) })
    db.transaction(() => {
      recordMemory(
        n.id,
        current.memory,
        'backup',
        req.user!.username,
        idx,
        '定稿前',
        current.memory_through_chapter ?? (!current.memory.trim() ? 0 : undefined),
      )
      invalidateWriterMemory(db, n.id, idx + 1)
      if (JSON.stringify(next) !== JSON.stringify(current))
        db.prepare('UPDATE novel_docs SET content=?,updated_at=CURRENT_TIMESTAMP WHERE novel_id=? AND doc_type=?').run(
          JSON.stringify(next),
          n.id,
          DOC,
        )
      db.prepare("UPDATE novel_chapters SET status='finalized',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(row.id)
      recordMemory(n.id, memory, 'finalize', req.user!.username, idx, row.title, idx)
      db.prepare(
        "UPDATE novel_chapters SET status='needs_review' WHERE novel_id=? AND chapter_number>? AND status='finalized'",
      ).run(n.id, idx)
      bumpContextRevision(db, n.id)
    })()
    res.json({
      message: '章节已定稿，Memory 已更新并保存为历史版本',
      settings: next,
      chapter: chapter(chapterRow(n.id, idx), idx),
    })
  } catch (e: any) {
    res.status(e.status || 400).json({ message: e.message })
  }
})
router.post(prefix + '/save', (req, res) => {
  try {
    const b = req.body,
      n = res.locals.novel,
      idx = integer(b.chapter_idx, 1, 999999, '章节号'),
      current = chapter(chapterRow(n.id, idx), idx)
    for (const [k, max] of [
      ['content', 500000],
      ['raw_script', 100000],
      ['title', 500],
      ['author_note', 20000],
    ] as const)
      text(b[k], max, k)
    if (
      !b.base_chapter ||
      ['content', 'raw_script', 'title', 'author_note'].some(k => b.base_chapter[k] !== (current as any)[k])
    )
      throw new ContextConflict('章节已被其他页面修改，请重新载入后合并，当前输入未覆盖它')
    if (b.incomplete !== undefined && typeof b.incomplete !== 'boolean') fail('正文未完成标记无效')
    if (b.base_chapter.incomplete !== undefined && b.base_chapter.incomplete !== current.incomplete)
      throw new ContextConflict('正文完成状态已变化，请重新载入后合并')
    if (b.last_context && JSON.stringify(b.last_context).length > 2000000) fail('上下文记录过大')
    getDB().transaction(() => {
      const row = ensureChapter(n.id, idx)
      if (row.title !== b.title || row.author_note !== b.author_note) bumpContextRevision(getDB(), n.id)
      const incomplete = b.incomplete ?? current.incomplete
      getDB()
        .prepare(
          'UPDATE novel_chapters SET title=?,author_note=?,writer_last_context=?,writer_incomplete=?,updated_at=CURRENT_TIMESTAMP WHERE id=?',
        )
        .run(b.title, b.author_note, JSON.stringify(b.last_context || null), Number(incomplete), row.id)
      if (incomplete !== current.incomplete) {
        getDB().prepare("UPDATE novel_chapters SET status='draft' WHERE id=?").run(row.id)
        bumpContextRevision(getDB(), n.id)
      }
      writeOutline(row, b.raw_script, { user: (req as AuthRequest).user!.username, note: '写作台保存前' })
      saveChapterContent(getDB(), n.id, row, b.content, '写作台保存前')
    })()
    res.json(chapter(chapterRow(n.id, idx), idx))
  } catch (e: any) {
    res.status(e.status || 400).json({ message: e.message })
  }
})
router.post(prefix + '/context', async (req, res) => {
  try {
    res.json(await context(res.locals.novel, request(req.body)))
  } catch (e: any) {
    res.status(400).json({ message: e.message })
  }
})
/** Server-sent events to the browser: a live preview of prose; the final `done` event carries the real result. */
interface LiveStream {
  send: (event: object) => void
  end: (event: object) => void
}
function openLiveStream(res: any): LiveStream {
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  })
  res.flushHeaders()
  const send = (event: object) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`)
  }
  return {
    send,
    end: event => {
      send(event)
      res.end()
    },
  }
}

/**
 * Keeps continuing until the model ends on its own (each NovelAI response is capped at ~110 s), then verifies
 * the script and continues for trailing events it never reached. Falls back to an unfinished draft at the cap.
 */
async function finishChapter(
  n: any,
  input: any,
  config: LLMConfig,
  temperature: number,
  b: any,
  first: string,
  firstCompletion: { incomplete: boolean; finish_reason: string },
  ctx: any,
  live?: LiveStream | null,
) {
  let content = b.mode === 'continue' ? joinSegments(b.content, first) : first
  let completion = firstCompletion
  let segments = 1
  const beats = outlineBeats(b.raw_script)
  const warnings: string[] = []
  const segment = async (extra: { resume_mid_sentence?: boolean; remaining_beats?: string[] }) => {
    const next = requireWriterBudget(await context(n, { ...input, mode: 'continue', content, ...extra }, 'continue'))
    segments++
    live?.send({
      type: 'segment',
      separator: endsMidSentence(content) ? '' : '\n\n',
      status: extra.remaining_beats ? '补写台本末尾尚未写到的事件' : `正文较长，正在接续第 ${segments} 段`,
    })
    const result = await invokeWithRetryResult(
      { ...config, temperature, max_tokens: next.budget.output_tokens },
      next.system_prompt,
      next.user_prompt,
      1,
      { novel_id: n.id, task: `writer:segment:${b.chapter_idx}#${segments}` },
      true,
      live ? text => live.send({ type: 'delta', text }) : undefined,
    )
    if (!result.text.trim() || result.text.includes('<think>')) return false
    content = joinSegments(content, result.text)
    completion = result
    return true
  }
  const finishCut = async () => {
    while (completion.incomplete && segments < MAX_SEGMENTS) {
      if (!(await segment({ resume_mid_sentence: endsMidSentence(content) }))) break
    }
  }
  try {
    await finishCut()
    // Script coverage: continue once for events after the last written one; report skipped ones.
    if (!completion.incomplete && beats.length > 1) {
      live?.send({ type: 'status', status: '核对台本是否写全' })
      const checked = await invokeWithRetryResult(
        { ...config, temperature: 0.1, max_tokens: Math.min(config.max_tokens, 1024) },
        COVERAGE_SYSTEM,
        coverageInput(beats, content),
        1,
        { novel_id: n.id, task: `writer:coverage:${b.chapter_idx}` },
      ).catch(() => null)
      const coverage = checked && parseCoverage(checked.text, beats.length)
      if (!coverage) warnings.push('台本覆盖核对没有得到可靠结果，请在精修结果中核对事件是否写全。')
      else {
        if (coverage.trailing.length && segments < MAX_SEGMENTS) {
          await segment({ remaining_beats: coverage.trailing.map(i => beats[i - 1]) })
          await finishCut()
        } else if (coverage.trailing.length)
          warnings.push(`台本第 ${coverage.trailing.join('、')} 项尚未写到，已达到自动分段上限。`)
        if (coverage.beyond_end) warnings.push('正文在台本落点之后还写了台本没有的新情节，请核对并删改结尾。')
        if (coverage.skipped.length)
          warnings.push(`台本第 ${coverage.skipped.join('、')} 项可能被跳过，接续无法补在中间，请在精修结果中核对。`)
      }
    }
  } catch (e: any) {
    // A later segment failing must not lose what earlier segments produced.
    warnings.push(`自动分段在第 ${segments} 段中断：${redactKey(String(e.message), config)}`)
    completion = { incomplete: true, finish_reason: 'segment_failed' }
  }
  if (completion.incomplete && segments >= MAX_SEGMENTS)
    warnings.push(`已自动分 ${segments} 段生成，仍未写完，保留为未完成草稿。`)
  return {
    content: stripProseMarkers(content),
    context: { ...ctx, warnings: [...ctx.warnings, ...warnings] },
    incomplete: completion.incomplete,
    finish_reason: completion.finish_reason,
    segments,
    warnings,
  }
}

for (const [path, kind] of [
  ['/generate', 'generate'],
  ['/revise', 'revise'],
  ['/memory/suggest', 'memory'],
  ['/lore/polish', 'lore'],
]) {
  router.post(prefix + path, async (req, res) => {
    let config: LLMConfig | null = null
    let live: LiveStream | null = null
    try {
      const n = res.locals.novel,
        b = request(req.body),
        task = kind === 'generate' ? b.mode : kind
      if (task === 'write' && !b.raw_script.trim()) fail('请先填写完整台本')
      if (['continue', 'memory'].includes(task) && !b.content.trim()) fail('请先提供正文')
      if (kind === 'generate') requireMemoryTime(b.settings, b.chapter_idx, b.mode)
      const input: any = { ...b }
      if (task === 'lore') {
        input.lore_entry = validateSettings({ ...b.settings, lorebook: [req.body.lore_entry] }).lorebook[0]
        if (!input.lore_entry.title.trim() || !input.lore_entry.text.trim()) fail('请填写条目名称和设定正文')
      }
      if (task === 'revise') {
        for (const [key, max] of [
          ['before', 500000],
          ['selected', 100000],
          ['after', 500000],
          ['instruction', 20000],
        ] as const)
          input[key] = text(req.body[key], max, key)
        if (!input.selected.trim() || !input.instruction.trim()) fail('请选择正文并填写修改要求')
        if (input.before + input.selected + input.after !== input.content)
          throw new ContextConflict('选区已变化，请重新选择')
      }
      if (task === 'memory' && b.content !== chapterRow(n.id, b.chapter_idx)?.content)
        throw new ContextConflict('请先保存并确认本章正文，再整理记忆')
      if (task === 'memory') requireMemoryTime(b.settings, b.chapter_idx, 'write')
      config = getLLMConfigById(
        Number(task === 'lore' ? b.settings.lore_model_id || b.settings.model_id : b.settings.model_id),
      )
      if (!config) fail(task === 'lore' ? '请选择已配置的设定生成模型' : '请在参数里选择已配置的创作模型')
      if (kind === 'generate' && req.body.prepared_id !== undefined) {
        const prepared = sourceArtifact(n, req.body.prepared_id, 'prepare', b)
        if (prepared.preparation.conflicts.length) fail('写前发现材料冲突，请先核对 Memory、台本或设定，再生成正文')
        input.preparation = prepared.preparation
        input.preparation_warning = prepared.preparation_warning
      }
      const ctx = requireWriterBudget(await context(n, input, task))
      if (input.preparation_warning) ctx.warnings.push(input.preparation_warning)
      const temperature =
        task === 'lore'
          ? Math.min(0.4, b.settings.lore_model_id ? config!.temperature : b.settings.temperature)
          : b.settings.temperature
      live = kind === 'generate' && req.body.stream === true ? openLiveStream(res) : null
      live?.send({
        type: 'start',
        base: b.mode === 'continue' && b.content.trim() ? b.content + (endsMidSentence(b.content) ? '' : '\n\n') : '',
      })
      const completion = await invokeWithRetryResult(
        { ...config!, temperature, max_tokens: ctx.budget.output_tokens },
        ctx.system_prompt,
        ctx.user_prompt,
        1,
        { novel_id: n.id, task: `writer:${task}:${b.chapter_idx}` },
        kind === 'generate',
        live ? text => live!.send({ type: 'delta', text }) : undefined,
      )
      const output = completion.text
      if (!output.trim() || output.includes('<think>')) fail('模型未返回有效正文')
      if (kind === 'generate') {
        const generated = await finishChapter(n, input, config!, temperature, b, output, completion, ctx, live)
        const artifact_id = getDB().transaction(() =>
          archive(n.id, ensureChapter(n.id, b.chapter_idx).id, task, input, generated),
        )()
        if (live) live.end({ type: 'done', result: { ...generated, artifact_id } })
        else res.json({ ...generated, artifact_id })
        return
      }
      if (task === 'lore') {
        if (output.length > 50000) fail('整理结果超过设定正文 50000 字符上限，请缩短条目后重试')
        res.json({ text: output, context: ctx })
        return
      }
      const result =
        task === 'memory'
          ? { memory: output, context: ctx }
          : task === 'revise'
            ? { replacement: output, context: ctx }
            : {
                content: task === 'continue' ? b.content + '\n\n' + output : output,
                context: ctx,
                incomplete: completion.incomplete,
                finish_reason: completion.finish_reason,
              }
      const artifact_id = getDB().transaction(() =>
        archive(n.id, ensureChapter(n.id, b.chapter_idx).id, task, input, result),
      )()
      res.json({ ...result, artifact_id })
    } catch (e: any) {
      const message = redactKey(String(e.message || '模型调用失败'), config)
      if (live) live.end({ type: 'error', message })
      else res.status(e.status || 400).json({ message })
    }
  })
}
// Illustrations (Lorebook portraits, chapter backgrounds): one at a time per book, always started by the author.
const illustrationsInFlight = new Set<number>()
type Illustrated = { prompt: string; image: Buffer }
async function illustrate(
  n: any,
  s: Settings,
  brief: { system: string; input: string; task: string },
): Promise<Illustrated & { configs: (LLMConfig | null)[] }> {
  const textConfig = getLLMConfigById(Number(s.lore_model_id || s.model_id))
  const imageConfig = s.image_model_id ? getLLMConfigById(Number(s.image_model_id)) : null
  const configs = [textConfig, imageConfig]
  try {
    if (!textConfig) fail('请先选择创作模型或设定生成模型，用于整理画面描述')
    if (!imageConfig) fail('请先在设定页选择生图模型')
    if (illustrationsInFlight.has(n.id)) throw Object.assign(new Error('上一张图片仍在生成，请稍后'), { status: 429 })
    illustrationsInFlight.add(n.id)
  } catch (e: any) {
    throw Object.assign(e, { configs })
  }
  try {
    const tags = await invokeWithRetryResult(
      { ...textConfig!, temperature: 0.3, max_tokens: Math.min(textConfig!.max_tokens, 1024) },
      brief.system,
      brief.input,
      1,
      { novel_id: n.id, task: `writer:${brief.task}-tags` },
    )
    const prompt = `${sanitizeTags(tags.text)}, ${QUALITY_TAGS}`
    const started = Date.now()
    const logId = addLLMCallLog({
      novel_id: n.id,
      task: `writer:${brief.task}-image`,
      model_name: imageConfig!.model_name,
      system_prompt: '',
      user_prompt: prompt,
      response: '',
      duration_ms: 0,
      status: 'pending',
    })
    try {
      const image = await generateNovelAIImage(imageConfig!, prompt)
      updateLLMCallLog(logId, {
        response: `PNG ${image.length} bytes`,
        duration_ms: Date.now() - started,
        status: 'success',
      })
      return { prompt, image, configs }
    } catch (e: any) {
      updateLLMCallLog(logId, {
        duration_ms: Date.now() - started,
        status: 'error',
        error: redactKey(String(e.message), imageConfig),
      })
      throw e
    }
  } catch (e: any) {
    throw Object.assign(e, { configs })
  } finally {
    illustrationsInFlight.delete(n.id)
  }
}
function illustrationError(res: any, e: any, fallback: string) {
  let message = String(e.message || fallback)
  for (const config of e.configs || []) message = redactKey(message, config)
  res.status(e.status || 400).json({ message })
}
const sendImage = (res: any, row: any, missing: string) =>
  row
    ? res.type('image/png').set('Cache-Control', 'private, no-cache').send(row.image)
    : res.status(404).json({ message: missing })

router.post(prefix + '/lore/portrait', async (req, res) => {
  const n = res.locals.novel
  try {
    const s = validateSettings(req.body.settings)
    const entry = validateSettings({ ...s, lorebook: [req.body.lore_entry] }).lorebook[0]
    if (!entry.title.trim() || !entry.text.trim()) fail('请填写条目名称和设定正文')
    // Characters get a portrait in their setting; other entries (places, factions, rules) get a scene.
    const character = isCharacterEntry(entry)
    const { prompt, image } = await illustrate(n, s, {
      system: character ? PORTRAIT_TAG_SYSTEM : SCENE_TAG_SYSTEM,
      input: character ? portraitTagInput(entry) : loreSceneInput(entry),
      task: 'portrait',
    })
    const updated_at = new Date().toISOString()
    getDB()
      .prepare(
        `INSERT INTO lore_portraits(novel_id,entry_id,prompt,image,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(novel_id,entry_id) DO UPDATE SET prompt=excluded.prompt,image=excluded.image,updated_at=excluded.updated_at`,
      )
      .run(n.id, entry.id, prompt, image, updated_at)
    res.json({ entry_id: entry.id, prompt, updated_at })
  } catch (e: any) {
    illustrationError(res, e, '设定背景图生成失败')
  }
})
router.get(prefix + '/lore/portraits', (_req, res) => {
  res.json({
    items: getDB()
      .prepare('SELECT entry_id, updated_at FROM lore_portraits WHERE novel_id=? ORDER BY updated_at DESC')
      .all(res.locals.novel.id),
  })
})
router.get(prefix + '/lore/portrait/:entry', (req, res) => {
  const row = getDB()
    .prepare('SELECT image FROM lore_portraits WHERE novel_id=? AND entry_id=?')
    .get(res.locals.novel.id, req.params.entry)
  sendImage(res, row, '该条目还没有背景图')
})

// Chapter backgrounds come from the saved chapter (title, script, opening prose), never from unsaved edits.
router.post(prefix + '/chapter/:idx/background', async (req: AuthRequest, res) => {
  const n = res.locals.novel
  try {
    const idx = integer(Number(req.params.idx), 1, 999999, '章节号')
    const s = validateSettings(req.body.settings)
    const row = chapterRow(n.id, idx)
    if (!row?.outline?.trim() && !row?.content?.trim()) fail('请先填写并保存本章台本或正文')
    const { prompt, image } = await illustrate(n, s, {
      system: SCENE_TAG_SYSTEM,
      input: sceneTagInput({ title: row.title, script: row.outline || '', prose: row.content || '' }),
      task: 'chapter-background',
    })
    const updated_at = new Date().toISOString()
    getDB()
      .prepare(
        `INSERT INTO chapter_backgrounds(chapter_id,novel_id,prompt,image,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(chapter_id) DO UPDATE SET prompt=excluded.prompt,image=excluded.image,updated_at=excluded.updated_at`,
      )
      .run(row.id, n.id, prompt, image, updated_at)
    res.json({ chapter_idx: idx, prompt, updated_at })
  } catch (e: any) {
    illustrationError(res, e, '章节背景图生成失败')
  }
})
router.get(prefix + '/chapter-backgrounds', (_req, res) => {
  res.json({
    items: getDB()
      .prepare(
        `SELECT c.chapter_number AS chapter_idx, b.updated_at FROM chapter_backgrounds b
        JOIN novel_chapters c ON c.id=b.chapter_id WHERE b.novel_id=? ORDER BY c.chapter_number`,
      )
      .all(res.locals.novel.id),
  })
})
router.get(prefix + '/chapter/:idx/background', (req, res) => {
  const row = getDB()
    .prepare(
      `SELECT b.image FROM chapter_backgrounds b JOIN novel_chapters c ON c.id=b.chapter_id
      WHERE c.novel_id=? AND c.chapter_number=?`,
    )
    .get(res.locals.novel.id, Number(req.params.idx))
  sendImage(res, row, '本章还没有背景图')
})
router.get(prefix + '/chapter/:idx/history', (req, res) => {
  const rows = getDB()
    .prepare(
      `SELECT a.id,a.kind,a.created_at FROM writer_artifacts a JOIN novel_chapters c ON c.id=a.chapter_id WHERE a.novel_id=? AND c.chapter_number=? ORDER BY a.created_at DESC,a.id DESC`,
    )
    .all(res.locals.novel.id, Number(req.params.idx))
  res.json({ items: rows })
})
router.get(prefix + '/chapter/:idx/history/:artifact', (req, res) => {
  const row = getDB()
    .prepare(
      `SELECT a.content FROM writer_artifacts a JOIN novel_chapters c ON c.id=a.chapter_id WHERE a.novel_id=? AND c.chapter_number=? AND a.id=?`,
    )
    .get(res.locals.novel.id, Number(req.params.idx), req.params.artifact) as any
  if (!row) return res.status(404).json({ message: '生成记录不存在' })
  res.json(JSON.parse(row.content))
})
router.get(prefix + '/download', (req, res) => {
  const n = res.locals.novel,
    format = String(req.query.format || 'txt')
  if (!['txt', 'md', 'json'].includes(format)) return res.status(400).json({ message: '导出格式无效' })
  const db = getDB(),
    rows = db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? ORDER BY chapter_number').all(n.id) as any[]
  res.attachment(`mountain-view-${n.id}.${format}`)
  if (format === 'json')
    return res.type('json').send(
      JSON.stringify(
        {
          format: 'mountain-view-writing-backup-v1',
          novel: n,
          docs: db.prepare('SELECT doc_type,content FROM novel_docs WHERE novel_id=?').all(n.id),
          chapters: rows,
          memory_history: db.prepare('SELECT * FROM writer_memory_history WHERE novel_id=? ORDER BY id').all(n.id),
          writer_artifacts: db.prepare('SELECT * FROM writer_artifacts WHERE novel_id=?').all(n.id),
          chapter_revisions: db
            .prepare(
              'SELECT r.* FROM chapter_revisions r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?',
            )
            .all(n.id),
          outline_revisions: db
            .prepare(
              'SELECT r.* FROM chapter_outline_revisions r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?',
            )
            .all(n.id),
          outline_reviews: db
            .prepare(
              'SELECT r.* FROM chapter_outline_reviews r JOIN novel_chapters c ON c.id=r.chapter_id WHERE c.novel_id=?',
            )
            .all(n.id),
          models: getLLMConfigs().map(publicModel),
        },
        null,
        2,
      ),
    )
  const parts = rows
    .filter(c => c.content.trim())
    .map(c => {
      const title = c.title.replace(/^第\s*\d+\s*章\s*/, '').trim()
      return `${format === 'md' ? '# ' : ''}第 ${c.chapter_number} 章${title ? ' ' + title : ''}\n\n${c.content.trim()}`
    })
  if (!parts.length) return res.status(400).json({ message: '请先保存至少一章正文' })
  res.type('text/plain; charset=utf-8').send('\ufeff' + n.title + '\n\n' + parts.join('\n\n\n'))
})
export default router
