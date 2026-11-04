/** Book-level tools around the writing desk: style, script tidy-up, model chat test, call logs, chapter delete. */
import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { getLLMConfigById, LLMConfig, redactKey } from '../llm/config'
import { invokeWithRetry } from '../llm/invoke'
import { invokeChat, ChatMessage } from '../llm/adapter'
import * as P from '../llm/prompts'
import { assertContextRevision, bumpContextRevision, invalidateFromChapter, ContextConflict } from '../llm/revision'
import { parseOutlineCandidate, validateOutline, writeOutline } from '../llm/outline-review'
import { getLogsByNovelId, clearLogsByNovelId } from '../llm/logstore'
import { writerSettings, loreText } from '../llm/writer-state'
import {
  STYLE_DOC,
  STYLE_DIMENSIONS,
  styleAnalysisInput,
  sampleStyleSources,
  parseStyleAnalysis,
  renderStyleGuide,
  readStyleProfile,
  validateStyleProfile,
  styleRevision,
} from '../llm/writer-style'
import { getNovelOrForbid } from './shared'

const router = Router()

router.param('num', (_req, res, next, value) => {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1)
    return res.status(400).json({ message: '章节号必须是正整数' })
  next()
})

// Every route here is scoped to one novel the user owns.
router.use('/:id', authenticate, (req: AuthRequest, res, next) => {
  const novel = getNovelOrForbid(getDB(), req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  res.locals.novel = novel
  next()
})

/** The writing desk's creative model; book-level tools use the same choice. */
function creativeModel(novel: any): LLMConfig | null {
  const id = writerSettings(getDB(), novel.id).model_id
  return id ? getLLMConfigById(Number(id)) : null
}

function chatTestConfigs(novel: any) {
  const s = writerSettings(getDB(), novel.id)
  return [...new Set([s.model_id, s.lore_model_id].filter(Boolean))]
    .map(id => getLLMConfigById(Number(id)))
    .filter((c): c is LLMConfig => !!c)
}

router.get('/:id/chat-test', (_req, res) => {
  res.json({ configs: chatTestConfigs(res.locals.novel).map(c => ({ name: c.name, model_name: c.model_name })) })
})

router.post('/:id/chat-test', async (req, res) => {
  const config = chatTestConfigs(res.locals.novel).find(c => c.name === req.body?.config_name)
  if (!config) return res.status(400).json({ message: '请选择写作台已选用的模型' })
  const { messages, system_prompt = '' } = req.body || {}
  if (
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 39 ||
    messages.length % 2 !== 1 ||
    messages.some(
      (m: any, i: number) =>
        !m ||
        m.role !== (i % 2 === 0 ? 'user' : 'assistant') ||
        typeof m.content !== 'string' ||
        !m.content.trim() ||
        m.content.length > 8000,
    )
  ) {
    return res.status(400).json({ message: '对话需按用户、模型顺序交替并以用户消息结尾；每条最多 8000 字，最多 20 轮' })
  }
  if (
    typeof system_prompt !== 'string' ||
    system_prompt.length > 2000 ||
    messages.reduce((n: number, m: any) => n + m.content.length, system_prompt.length) > 16000
  ) {
    return res.status(400).json({ message: '系统提示最多 2000 字，对话总计最多 16000 字；请新建对话后继续' })
  }
  const started = Date.now()
  try {
    // 只发送测试会话，不拼接小说上下文、不写记忆，也不自动重试。
    const turns: ChatMessage[] = messages.map((m: ChatMessage) => ({ role: m.role, content: m.content }))
    if (system_prompt.trim()) turns.unshift({ role: 'system', content: system_prompt })
    const result = await invokeChat(config, turns)
    res.json({ ...result, model_name: config.model_name, duration_ms: Date.now() - started })
  } catch (err: any) {
    res.status(502).json({ message: redactKey(String(err.message || '模型调用失败'), config) })
  }
})

// Extraction is a preview. Only explicit adoption changes the author's style.
router.get('/:id/style/profile', (_req, res) => {
  const db = getDB(),
    novel = res.locals.novel
  res.json({
    style_guide: novel.style_guide || '',
    profile: readStyleProfile(db, novel.id),
    revision: styleRevision(db, novel),
  })
})

router.post('/:id/style/guide', async (req, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const config = creativeModel(novel)
  if (!config) return res.status(400).json({ message: '请先在写作台「参数」中选择创作模型' })
  const content = req.body?.content
  if (typeof content !== 'string' || content.trim().length < 100 || content.length > 1000000) {
    return res.status(400).json({ message: '请提供 100 至 100 万字符的范文' })
  }
  const base_revision = styleRevision(db, novel)
  try {
    const samples = sampleStyleSources(content)
    const raw = await invokeWithRetry(
      { ...config, temperature: Math.min(config.temperature, 0.3) },
      P.SYSTEM_STYLE_EXTRACT,
      P.USER_STYLE_EXTRACT(styleAnalysisInput(samples)),
      1,
      { novel_id: novel.id, task: 'extract-style' },
    )
    let skipped_count = 0
    const profile = parseStyleAnalysis(
      raw,
      samples,
      () => {
        skipped_count++
      },
      true,
    )
    profile.samples.unshift(...(readStyleProfile(db, novel.id)?.samples.filter(s => s.manual) || []))
    res.json({
      style_guide: renderStyleGuide(profile),
      profile,
      base_revision,
      skipped_count,
      missing_dimensions: STYLE_DIMENSIONS.filter(d => !profile.observations.some(o => o.dimension === d)),
    })
  } catch (err: any) {
    res.status(err.status || 502).json({ message: redactKey(String(err.message || '提取失败'), config) })
  }
})

router.put('/:id/style/guide', (req: AuthRequest, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const { style_guide, base_revision, profile } = req.body || {}
  if (typeof style_guide !== 'string' || style_guide.length > 20000 || typeof base_revision !== 'string') {
    return res.status(400).json({ message: '文风指南最多 20000 字符，请先加载当前版本' })
  }
  if (base_revision !== styleRevision(db, novel))
    return res.status(409).json({ message: '文风已在其他页面修改，请重新加载后核对；本次编辑尚未覆盖已存内容' })
  try {
    const validated = profile === undefined ? undefined : validateStyleProfile(profile)
    db.transaction(() => {
      db.prepare('UPDATE novels SET style_guide=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(style_guide, novel.id)
      if (validated)
        db.prepare(
          `INSERT INTO novel_docs (novel_id, doc_type, content) VALUES (?, ?, ?)
        ON CONFLICT(novel_id, doc_type) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP`,
        ).run(novel.id, STYLE_DOC, JSON.stringify(validated))
      else if (validated === null)
        db.prepare('DELETE FROM novel_docs WHERE novel_id=? AND doc_type=?').run(novel.id, STYLE_DOC)
      bumpContextRevision(db, novel.id)
    })()
    const current = getNovelOrForbid(db, req.params.id, req)!
    res.json({ style_guide, profile: readStyleProfile(db, novel.id), revision: styleRevision(db, current) })
  } catch (err: any) {
    res.status(400).json({ message: String(err.message || '保存失败') })
  }
})

function chapterByNumber(novelId: number, num: string) {
  return getDB()
    .prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?')
    .get(novelId, Number(num)) as any
}

// 台本整理：生成候选，作者编辑并显式采纳后才替换台本。
router.post('/:id/polish/outline/:num', async (req, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const config = creativeModel(novel)
  if (!config) return res.status(400).json({ message: '请先在写作台「参数」中选择创作模型' })
  const chapterNum = Number(req.params.num)
  const chapter = chapterByNumber(novel.id, req.params.num)
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  const row = db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
  try {
    if (
      req.body?.outline_revision !== chapter.outline_revision ||
      (req.body?.review_id || null) !== (row?.review_id || null)
    )
      throw new ContextConflict('台本或候选已变化，请重新载入后整理')
    validateOutline(chapter.outline)
    const settings = writerSettings(db, novel.id)
    const text = await invokeWithRetry(
      config,
      P.SYSTEM_POLISH_OUTLINE,
      P.USER_POLISH_OUTLINE(
        chapterNum,
        chapter.outline,
        loreText(settings, 'world'),
        loreText(settings, 'characters'),
        settings.memory,
        req.body?.compress_dialogue === true,
      ),
      3,
      { novel_id: novel.id, task: `polish-outline:${chapterNum}` },
    )
    const candidate = parseOutlineCandidate(text)
    const reviewId = randomUUID()
    db.transaction(() => {
      assertContextRevision(db, novel.id, novel.context_revision)
      const current = db
        .prepare('SELECT review_id FROM chapter_outline_reviews WHERE chapter_id=?')
        .get(chapter.id) as any
      if (current?.review_id !== row?.review_id)
        throw new ContextConflict('候选已在其他窗口保存，迟到的整理结果未覆盖它')
      db.prepare(
        `INSERT INTO chapter_outline_reviews(chapter_id,review_id,outline_revision,context_revision,content) VALUES (?,?,?,?,?)
        ON CONFLICT(chapter_id) DO UPDATE SET review_id=excluded.review_id,outline_revision=excluded.outline_revision,context_revision=excluded.context_revision,content=excluded.content`,
      ).run(chapter.id, reviewId, chapter.outline_revision, novel.context_revision, JSON.stringify(candidate))
    })()
    res.json({ ...candidate, review_id: reviewId, stale: false })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `整理失败：${redactKey(String(err.message), config)}` })
  }
})

router.get('/:id/chapters/:num/outline-review', (req, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const chapter = chapterByNumber(novel.id, req.params.num)
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  const row = db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
  res.json({
    original: chapter.outline,
    outline_revision: chapter.outline_revision,
    review: row
      ? {
          ...JSON.parse(row.content),
          review_id: row.review_id,
          stale: row.outline_revision !== chapter.outline_revision || row.context_revision !== novel.context_revision,
        }
      : null,
    versions: db
      .prepare(
        'SELECT id,note,created_by,created_at FROM chapter_outline_revisions WHERE chapter_id=? ORDER BY id DESC',
      )
      .all(chapter.id),
  })
})

router.put('/:id/chapters/:num/outline-review', (req: AuthRequest, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const chapter = chapterByNumber(novel.id, req.params.num)
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  try {
    const row = db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
    if (!row || row.review_id !== req.body?.review_id)
      throw new ContextConflict('候选已变化，请重新载入；当前编辑内容仍保留在窗口中')
    assertContextRevision(db, novel.id, row.context_revision)
    if (row.outline_revision !== chapter.outline_revision)
      throw new ContextConflict('原台本已修改，请按最新台本重新整理')
    validateOutline(req.body.outline)
    const candidate = JSON.parse(row.content)
    if (
      !Array.isArray(req.body.selected) ||
      req.body.selected.length > candidate.suggestions.length ||
      req.body.selected.some((i: any) => !Number.isInteger(i) || i < 0 || i >= candidate.suggestions.length)
    )
      throw new Error('建议选择无效')
    candidate.outline = req.body.outline
    candidate.selected = [...new Set(req.body.selected)]
    const reviewId = randomUUID(),
      confirm = req.body.confirm === true
    db.transaction(() => {
      if (confirm) {
        writeOutline(chapter, candidate.outline, { user: req.user!.username, note: '采纳整理候选前' })
        db.prepare('DELETE FROM chapter_outline_reviews WHERE chapter_id=?').run(chapter.id)
      } else
        db.prepare('UPDATE chapter_outline_reviews SET review_id=?,content=? WHERE chapter_id=?').run(
          reviewId,
          JSON.stringify(candidate),
          chapter.id,
        )
    })()
    res.json(
      confirm
        ? {
            outline: candidate.outline,
            outline_revision: chapter.outline_revision + (candidate.outline !== chapter.outline ? 1 : 0),
          }
        : { ...candidate, review_id: reviewId, stale: false },
    )
  } catch (err: any) {
    res.status(err.status || 400).json({ message: err.message })
  }
})

router.get('/:id/chapters/:num/outline-versions/:versionId', (req, res) => {
  const version = getDB()
    .prepare(
      `SELECT r.* FROM chapter_outline_revisions r JOIN novel_chapters c ON c.id=r.chapter_id
    WHERE c.novel_id=? AND c.chapter_number=? AND r.id=?`,
    )
    .get(res.locals.novel.id, Number(req.params.num), Number(req.params.versionId))
  if (!version) return res.status(404).json({ message: '台本版本不存在' })
  res.json(version)
})

router.post('/:id/chapters/:num/outline-versions/:versionId/restore', (req: AuthRequest, res) => {
  const db = getDB(),
    chapter = chapterByNumber(res.locals.novel.id, req.params.num)
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  const version = db
    .prepare('SELECT * FROM chapter_outline_revisions WHERE id=? AND chapter_id=?')
    .get(Number(req.params.versionId), chapter.id) as any
  if (!version) return res.status(404).json({ message: '台本版本不存在' })
  try {
    if (req.body?.outline_revision !== chapter.outline_revision)
      throw new ContextConflict('当前台本已变化，请重新载入再恢复')
    db.transaction(() => writeOutline(chapter, version.outline, { user: req.user!.username, note: '恢复历史版本前' }))()
    res.json({
      outline: version.outline,
      outline_revision: chapter.outline_revision + (version.outline !== chapter.outline ? 1 : 0),
    })
  } catch (err: any) {
    res.status(err.status || 400).json({ message: err.message })
  }
})

router.delete('/:id/chapters/:chapterId', (req, res) => {
  const db = getDB(),
    novel = res.locals.novel
  const chapter = db
    .prepare('SELECT id, chapter_number FROM novel_chapters WHERE id = ? AND novel_id = ?')
    .get(Number(req.params.chapterId), novel.id) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  db.transaction(() => {
    db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(chapter.id)
    invalidateFromChapter(db, novel.id, chapter.chapter_number)
  })()
  res.json({ message: 'ok' })
})

router.get('/:id/llm-logs', (req, res) => {
  res.json(getLogsByNovelId(res.locals.novel.id, parseInt(req.query.limit as string) || 100))
})

router.delete('/:id/llm-logs', (_req, res) => {
  clearLogsByNovelId(res.locals.novel.id)
  res.json({ message: '日志已清空' })
})

export default router
