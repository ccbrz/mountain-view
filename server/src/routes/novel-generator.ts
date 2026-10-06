import { Router } from 'express'
import { randomUUID } from 'node:crypto'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { getLLMConfigs, getLLMConfigByName, LLMConfig } from '../llm/config'
import { invokeWithRetry, extractChapterBody } from '../llm/invoke'
import * as P from '../llm/prompts'
import { PersistentVectorStore } from '../llm/vectorstore'
import { saveProgressSnapshot, progressBeforeChapter, requireProgressBeforeChapter, listProgressSnapshots, getProgressSnapshot, invalidateFromChapter, bumpContextRevision, assertContextRevision, ContextConflict } from '../llm/doc-snapshots'
import { updateProgress, emptyState, renderProgress } from '../llm/progress'
import { editableMemory, reviewedProgress } from '../llm/memory-review'
import { parseOutlineCandidate, validateOutline, writeOutline } from '../llm/outline-review'
import { reviewChapter } from '../llm/review'
import { revisePatchwise } from '../llm/revise'
import { addLLMCallLog, getLogsByNovelId, clearLogsByNovelId } from '../llm/logstore'

import { chapterEvidence } from '../llm/chapter-evidence'
import { checkContinuity, ContinuityConflict } from '../llm/continuity'

const router = Router()

router.param('num', (_req, res, next, value) => {
  if (!Number.isSafeInteger(Number(value)) || Number(value) < 1) return res.status(400).json({ message: '章节号必须是正整数' })
  next()
})

// ---------- helpers ----------

function getNovelOrForbid(db: any, id: string, req: AuthRequest) {
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(id) as any
  if (!novel) return null
  const isAdmin = req.user?.role === 'admin'
  const isCreator = novel.creator_username === req.user!.username
  if (!isAdmin && !isCreator) return null
  return novel
}

const TASKS = ['architecture', 'chapter', 'finalize', 'consistency', 'rerank'] as const
type TaskType = typeof TASKS[number]

function getLLMConfigForTask(novel: any, req: AuthRequest, task: TaskType, fallback = true): LLMConfig | null {
  let configName = ''
  if (novel.llm_config) {
    try {
      if (novel.llm_config.startsWith('{')) {
        const map = JSON.parse(novel.llm_config)
        if (map[task]) configName = map[task]
        else if (fallback) {
          for (const t of TASKS) {
            if (map[t]) { configName = map[t]; break }
          }
        }
      } else if (fallback) {
        configName = novel.llm_config
      }
    } catch {
      if (fallback && typeof novel.llm_config === 'string' && novel.llm_config.length > 0) {
        configName = novel.llm_config
      }
    }
  }
  if (!configName && fallback) configName = req.body?.llm_config || ''
  if (!configName) return null
  return getLLMConfigByName(configName)
}

function saveLLMConfig(db: any, novelId: number, req: any, task: TaskType) {
  const configName = req.body?.llm_config
  if (!configName) return

  const novel = db.prepare('SELECT llm_config FROM novels WHERE id = ?').get(novelId) as any
  let map: Record<string, string> = {}
  if (novel?.llm_config) {
    try {
      if (novel.llm_config.startsWith('{')) {
        map = JSON.parse(novel.llm_config)
      }
    } catch {}
  }
  map[task] = configName
  db.prepare('UPDATE novels SET llm_config = ? WHERE id = ?').run(JSON.stringify(map), novelId)
}

function saveDoc(db: any, novelId: number, docType: string, content: string) {
  db.prepare(`
    INSERT INTO novel_docs (novel_id, doc_type, content) VALUES (?, ?, ?)
    ON CONFLICT(novel_id, doc_type) DO UPDATE SET content = excluded.content, updated_at = CURRENT_TIMESTAMP
  `).run(novelId, docType, content)
}

function getDoc(db: any, novelId: number, docType: string): string {
  const row = db.prepare('SELECT content FROM novel_docs WHERE novel_id = ? AND doc_type = ?').get(novelId, docType) as any
  return row?.content || ''
}

function updateNovelStatus(db: any, novelId: number, status: string) {
  db.prepare('UPDATE novels SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(status, novelId)
}

/** 调用方负责事务和异步结果的版本检查，所有正文写入共用失效逻辑。 */
function saveChapterContent(db: any, novelId: number, chapter: any, content: string, note = '') {
  if (content === chapter.content) return
  if (note && chapter.content) {
    db.prepare('INSERT INTO chapter_revisions (chapter_id, content, word_count, note) VALUES (?, ?, ?, ?)')
      .run(chapter.id, chapter.content, chapter.word_count || 0, note)
  }
  db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(content, content.replace(/\s/g, '').length, chapter.id)
  invalidateFromChapter(db, novelId, chapter.chapter_number)
}

async function indexChapter(db: any, novel: any, chapter: any) {
  // 每次任务独立保存配置，避免并发请求修改缓存实例上的 embedding 配置。
  const vs = new PersistentVectorStore(novel.id)
  vs.setEmbeddingConfig(novel.embedding_config || '')
  const segments = await vs.prepareChapter(chapter.content)
  db.transaction(() => {
    assertContextRevision(db, novel.id, novel.context_revision)
    const current = db.prepare('SELECT status FROM novel_chapters WHERE id = ?').get(chapter.id)
    if (current?.status !== 'finalized') throw new ContextConflict('章节尚未定稿，不能更新索引')
    vs.replaceChapter(chapter.chapter_number, segments)
    db.prepare("UPDATE novel_chapters SET index_status = 'ready' WHERE id = ?").run(chapter.id)
  })()
}

// ---------- RAG debug log helper ----------

function addRAGDebugLog(novelId: number, stage: string, content: string) {
  addLLMCallLog({
    novel_id: novelId,
    task: `rag:${stage}`,
    model_name: '🔍 RAG',
    system_prompt: '',
    user_prompt: content,
    response: '',
    duration_ms: 0,
    status: 'success',
  })
}

// ---------- GET /llm-configs ----------

router.get('/:id/llm-configs', authenticate, (_req: AuthRequest, res) => {
  const configs = getLLMConfigs().map((c) => ({
    name: c.name,
    model_name: c.model_name,
    base_url: c.base_url,
    temperature: c.temperature,
    max_tokens: c.max_tokens,
    has_key: !!c.api_key,
  }))
  res.json(configs)
})

// ---------- POST /:id/style/guide ----------
// 上传 txt 文件内容 → AI 总结文风指南 → 保存到 style_guide

/** 前端多个文件用这个分隔符拼接 */
const SAMPLE_SEP = '\n\n---\n\n'

/**
 * 范文总长压到 budget 以内。多个文件时平分预算——只截前 N 字的话后面的文件一个字都进不去；
 * 短文件用不完的份额留给长文件。截断处退到最近的句末，不给模型半句话。
 */
function fitStyleSamples(content: string, budget: number): string {
  if (content.length <= budget) return content
  const parts = content.split(SAMPLE_SEP)
  const caps = new Map<number, number>()
  let left = budget - SAMPLE_SEP.length * (parts.length - 1)
  // 从短到长分配：每个文件拿「剩余预算 / 剩余文件数」和自身长度中较小的那个
  parts.map((p, i) => [p.length, i]).sort((a, b) => a[0] - b[0]).forEach(([len, i], k, arr) => {
    const cap = Math.min(len, Math.floor(left / (arr.length - k)))
    caps.set(i, cap)
    left -= cap
  })
  return parts.map((p, i) => {
    const cap = caps.get(i)!
    if (p.length <= cap) return p
    const head = p.slice(0, cap)
    const end = Math.max(...['。', '！', '？', '…', '」', '”', '\n'].map((c) => head.lastIndexOf(c)))
    return end > cap / 2 ? head.slice(0, end + 1) : head
  }).join(SAMPLE_SEP)
}

router.post('/:id/style/guide', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'architecture')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  const { content } = req.body
  if (!content || content.trim().length < 100) {
    return res.status(400).json({ message: '范文内容太短，请至少提供100字以上的文本' })
  }

  try {
    const ctx = { novel_id: novel.id, task: 'extract-style' }
    const truncated = fitStyleSamples(content, 15000)

    const styleGuide = await invokeWithRetry(
      config,
      P.SYSTEM_STYLE_EXTRACT,
      P.USER_STYLE_EXTRACT(truncated),
      3,
      ctx
    )

    db.prepare('UPDATE novels SET style_guide = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(styleGuide, novel.id)

    res.json({ message: '文风指南提取完成', style_guide: styleGuide })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `文风提取失败: ${err.message}` })
  }
})

// ---------- POST /:id/polish/character ----------
// 润色弹窗里的单个角色卡，只返回结果，不落库（作者确认后随「保存」一起写入）

router.post('/:id/polish/character', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'architecture')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  const name = String(req.body?.name || '').trim()
  const body = String(req.body?.body || '').trim()
  if (!body) return res.status(400).json({ message: '先写点内容再润色' })

  // 其他角色作参照；编辑已有角色时排除它自己
  const others = getDoc(db, novel.id, 'characters')
    .split(/^(?=## )/m)
    .filter((block) => block.trim() && block.match(/^## (.*)$/m)?.[1].trim() !== name)
    .join('')
    .trim()

  try {
    const polished = await invokeWithRetry(
      config,
      P.SYSTEM_POLISH_CHARACTER,
      P.USER_POLISH_CHARACTER(name || '（未命名）', body, getDoc(db, novel.id, 'architecture'), others),
      3,
      { novel_id: novel.id, task: 'polish-character' },
    )
    res.json({ body: polished.trim() })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `润色失败: ${err.message}` })
  }
})

// ---------- POST /:id/polish/outline/:num ----------
// 把台本整理成按场景分段的格式，只返回结果，不落库（前端填回输入框后按原有方式保存）

router.post('/:id/polish/outline/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'chapter')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  const chapterNum = Number(req.params.num)
  if (isNaN(chapterNum)) return res.status(400).json({ message: '章节号无效' })
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,chapterNum) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  const row = db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any

  try {
    if (req.body?.outline_revision !== chapter.outline_revision || (req.body?.review_id || null) !== (row?.review_id || null)) throw new ContextConflict('台本或候选已变化，请重新载入后整理')
    validateOutline(chapter.outline)
    const text = await invokeWithRetry(
      config,
      P.SYSTEM_POLISH_OUTLINE,
      P.USER_POLISH_OUTLINE(
        chapterNum,
        chapter.outline,
        getDoc(db, novel.id, 'architecture'),
        getDoc(db, novel.id, 'characters'),
        progressBeforeChapter(db, novel.id, chapterNum),
        req.body?.compress_dialogue === true,
      ),
      3,
      { novel_id: novel.id, task: `polish-outline:${chapterNum}` },
    )
    const candidate = parseOutlineCandidate(text)
    const reviewId = randomUUID()
    db.transaction(() => {
      assertContextRevision(db,novel.id,novel.context_revision)
      const current = db.prepare('SELECT review_id FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
      if (current?.review_id !== row?.review_id) throw new ContextConflict('候选已在其他窗口保存，迟到的整理结果未覆盖它')
      db.prepare(`INSERT INTO chapter_outline_reviews(chapter_id,review_id,outline_revision,context_revision,content) VALUES (?,?,?,?,?)
        ON CONFLICT(chapter_id) DO UPDATE SET review_id=excluded.review_id,outline_revision=excluded.outline_revision,context_revision=excluded.context_revision,content=excluded.content`)
        .run(chapter.id,reviewId,chapter.outline_revision,novel.context_revision,JSON.stringify(candidate))
    })()
    res.json({ ...candidate, review_id:reviewId, stale:false })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `润色失败: ${err.message}` })
  }
})

router.get('/:id/chapters/:num/outline-review', authenticate, (req: AuthRequest,res) => {
  const db=getDB(), novel=getNovelOrForbid(db,req.params.id,req)
  if (!novel) return res.status(404).json({message:'小说不存在或无权限'})
  const chapter=db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({message:'章节不存在'})
  const row=db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
  res.json({original:chapter.outline,outline_revision:chapter.outline_revision,
    review:row ? {...JSON.parse(row.content),review_id:row.review_id,stale:row.outline_revision!==chapter.outline_revision || row.context_revision!==novel.context_revision} : null,
    versions:db.prepare('SELECT id,note,created_by,created_at FROM chapter_outline_revisions WHERE chapter_id=? ORDER BY id DESC').all(chapter.id)})
})

router.put('/:id/chapters/:num/outline-review', authenticate, (req: AuthRequest,res) => {
  const db=getDB(),novel=getNovelOrForbid(db,req.params.id,req)
  if (!novel) return res.status(404).json({message:'小说不存在或无权限'})
  const chapter=db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({message:'章节不存在'})
  try {
    const row=db.prepare('SELECT * FROM chapter_outline_reviews WHERE chapter_id=?').get(chapter.id) as any
    if (!row || row.review_id!==req.body?.review_id) throw new ContextConflict('候选已变化，请重新载入；当前编辑内容仍保留在窗口中')
    assertContextRevision(db,novel.id,row.context_revision)
    if (row.outline_revision!==chapter.outline_revision) throw new ContextConflict('原台本已修改，请按最新台本重新整理')
    validateOutline(req.body.outline)
    const candidate=JSON.parse(row.content)
    if (!Array.isArray(req.body.selected) || req.body.selected.length>candidate.suggestions.length || req.body.selected.some((i: any)=>!Number.isInteger(i)||i<0||i>=candidate.suggestions.length)) throw new Error('建议选择无效')
    candidate.outline=req.body.outline; candidate.selected=[...new Set(req.body.selected)]
    const reviewId=randomUUID(),confirm=req.body.confirm===true
    db.transaction(()=>{
      if(confirm) {
        writeOutline(chapter,candidate.outline,{user:req.user!.username,note:'采纳整理候选前'})
        db.prepare('DELETE FROM chapter_outline_reviews WHERE chapter_id=?').run(chapter.id)
      } else db.prepare('UPDATE chapter_outline_reviews SET review_id=?,content=? WHERE chapter_id=?').run(reviewId,JSON.stringify(candidate),chapter.id)
    })()
    res.json(confirm ? {outline:candidate.outline,outline_revision:chapter.outline_revision+(candidate.outline!==chapter.outline?1:0)} : {...candidate,review_id:reviewId,stale:false})
  } catch(err: any) {res.status(err.status||400).json({message:err.message})}
})

router.get('/:id/chapters/:num/outline-versions/:versionId', authenticate, (req: AuthRequest,res)=>{
  const db=getDB(),novel=getNovelOrForbid(db,req.params.id,req)
  if(!novel) return res.status(404).json({message:'小说不存在或无权限'})
  const version=db.prepare(`SELECT r.* FROM chapter_outline_revisions r JOIN novel_chapters c ON c.id=r.chapter_id
    WHERE c.novel_id=? AND c.chapter_number=? AND r.id=?`).get(novel.id,Number(req.params.num),Number(req.params.versionId))
  if(!version) return res.status(404).json({message:'台本版本不存在'})
  res.json(version)
})

router.post('/:id/chapters/:num/outline-versions/:versionId/restore', authenticate, (req: AuthRequest,res)=>{
  const db=getDB(),novel=getNovelOrForbid(db,req.params.id,req)
  if(!novel) return res.status(404).json({message:'小说不存在或无权限'})
  const chapter=db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,Number(req.params.num)) as any
  if(!chapter) return res.status(404).json({message:'章节不存在'})
  const version=db.prepare('SELECT * FROM chapter_outline_revisions WHERE id=? AND chapter_id=?').get(Number(req.params.versionId),chapter.id) as any
  if(!version) return res.status(404).json({message:'台本版本不存在'})
  try {
    if(req.body?.outline_revision!==chapter.outline_revision) throw new ContextConflict('当前台本已变化，请重新载入再恢复')
    db.transaction(()=>writeOutline(chapter,version.outline,{user:req.user!.username,note:'恢复历史版本前'}))()
    res.json({outline:version.outline,outline_revision:chapter.outline_revision+(version.outline!==chapter.outline?1:0)})
  }catch(err: any){res.status(err.status||400).json({message:err.message})}
})

// ---------- PUT /:id/style/reference ----------
// 上传范文片段（≤1000 字）→ 保存到 style_reference，用于 few-shot

router.put('/:id/style/reference', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const { content } = req.body
  if (!content || content.trim().length === 0) {
    return res.status(400).json({ message: '内容不能为空' })
  }
  if (content.length > 1000) {
    return res.status(400).json({ message: '范文片段不能超过1000字' })
  }

  db.prepare('UPDATE novels SET style_reference = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(content, novel.id)

  res.json({ message: '范文片段已保存' })
})

// ---------- POST /:id/generate/architecture ----------

router.post('/:id/generate/architecture', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'architecture')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  let stage = '核心种子生成'
  try {
    const userInput = req.body?.user_input || ''
    const ctx = { novel_id: novel.id, task: 'architecture' }
    // 作者决定是否重试；保留统一的超时、响应解析和调用日志，每步只请求一次。
    const coreSeed = await invokeWithRetry(config, P.SYSTEM_CORE_SEED,
      P.USER_CORE_SEED({ topic: novel.title, genre: novel.genre, guidance: novel.guidance, userInput }), 1, ctx)
    const results = [{ type: 'core_seed', content: coreSeed }]

    // 世界观要参考角色，所以角色先生成；角色单独存一份静态档案，不拼进架构
    stage = '角色档案生成'
    const charsContent = await invokeWithRetry(config, P.SYSTEM_CHARACTERS, P.USER_CHARACTERS(coreSeed), 1, ctx)
    results.push({ type: 'characters', content: charsContent })

    stage = '世界观生成'
    const worldContent = await invokeWithRetry(config, P.SYSTEM_WORLD_BUILDING, P.USER_WORLD_BUILDING(`${coreSeed}\n\n${charsContent}`), 1, ctx)
    results.push({ type: 'worldbuilding', content: worldContent })

    stage = '架构保存'
    db.transaction(() => {
      assertContextRevision(db, novel.id, novel.context_revision)
      saveDoc(db, novel.id, 'architecture', `=== 核心种子 ===\n${coreSeed}\n\n=== 世界观 ===\n${worldContent}`)
      saveDoc(db, novel.id, 'characters', charsContent)
      invalidateFromChapter(db, novel.id, 1, true)
      updateNovelStatus(db, novel.id, 'architecture_done')
    })()

    res.json({ message: '架构生成完成', results })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `${stage}失败：${err.message}。本次已停止，未自动重试，原有架构和角色档案未改动。` })
  }
})

// ---------- POST /:id/generate/chapter/:num ----------

router.post('/:id/generate/chapter/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'chapter')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'chapter')

  const chapterNum = Number(req.params.num)
  if (isNaN(chapterNum)) return res.status(400).json({ message: '章节号无效' })

  let chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  chapter ||= { chapter_number: chapterNum, title: `第${chapterNum}章`, outline: '', content: '', word_count: 0 }
  const outline = chapter.outline || ''

  try {
    const chapterCtx = { novel_id: novel.id, task: `chapter:${chapterNum}` }
    let context = P.STORY_CONTEXT(
      getDoc(db, novel.id, 'architecture'),
      getDoc(db, novel.id, 'characters'),
      progressBeforeChapter(db, novel.id, chapterNum),
    )
    if (outline) context += `\n=== 本章台本 ===\n${outline}\n`
    // 作者读完上一稿写的意见，放在 user prompt 最后（见 prompts.ts）。不给模型看旧稿，避免它在旧稿上小修小补
    const feedback = String(req.body?.feedback || '').trim()

    const history = await chapterEvidence(novel, chapterNum, `${chapter.title} ${outline}`)
    context += history.text
    addRAGDebugLog(novel.id, '历史原文', history.text + history.warning)

    // 文风指南 → system prompt；范文片段 → user prompt 设定块之前（文案见 prompts.ts）
    const isFirst = chapterNum === 1
    const targetWords = novel.word_number || 2000
    const styleRef = novel.style_reference || ''
    const systemPrompt = P.draftSystemPrompt(isFirst, novel.style_guide || '', targetWords)
    const userPrompt = isFirst
      ? P.USER_FIRST_CHAPTER(context, styleRef, feedback)
      : P.USER_CHAPTER_DRAFT(`当前是第 ${chapterNum} 章：${chapter.title}\n\n${context}`, styleRef, feedback)

    addRAGDebugLog(novel.id, '4-最终生成上下文', userPrompt)

    let finalContent = extractChapterBody(await invokeWithRetry(config, systemPrompt, userPrompt, 3, chapterCtx))
    if (!finalContent.trim()) throw new Error('模型未返回正文，原稿未改动')
    const guardConfig = getLLMConfigForTask(novel, req, 'consistency') || config
    let issues = await checkContinuity(guardConfig, context, finalContent, { novel_id: novel.id, task: `continuity:draft:${chapterNum}` })
    if (issues.length) {
      finalContent = extractChapterBody(await invokeWithRetry(config, systemPrompt,
        userPrompt + `\n\n上一稿：\n${finalContent}\n\n请修复以下连续性问题后输出完整正文：\n${JSON.stringify(issues)}`, 3, chapterCtx))
      if (!finalContent.trim()) throw new Error('修复未返回正文，原稿未改动')
      issues = await checkContinuity(guardConfig, context, finalContent, { novel_id: novel.id, task: `continuity:retry:${chapterNum}` })
    }
    const wordCount = finalContent.replace(/\s/g, '').length

    db.transaction(() => {
      assertContextRevision(db, novel.id, novel.context_revision)
      if (!chapter.id) {
        chapter.id = Number(db.prepare('INSERT INTO novel_chapters (novel_id, chapter_number, title) VALUES (?, ?, ?)')
          .run(novel.id, chapterNum, chapter.title).lastInsertRowid)
      }
      db.prepare('UPDATE novel_chapters SET content_before_draft = ? WHERE id = ?').run(chapter.content, chapter.id)
      saveChapterContent(db, novel.id, chapter, finalContent, feedback ? `按意见重新生成前存档：${feedback.slice(0, 40)}` : '重新生成前存档')
      updateNovelStatus(db, novel.id, 'in_progress')
    })()

    // 模型审校会误报；草稿应可供作者审阅。旧稿已有修订存档，未定稿内容不会进入记忆或检索。
    const continuityWarning = issues.length ? `草稿待核对：${issues.map(i => i.problem).join('；')}。尚未定稿或更新记忆。` : ''
    res.json({ message: '章节生成完成', chapter_number: chapterNum, word_count: wordCount, warning: [history.warning, continuityWarning].filter(Boolean).join('\n') })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `章节生成失败: ${err.message}` })
  }
})

// ---------- 人工定稿：整理候选 → 核对编辑 → 原子确认 ----------

router.post('/:id/chapters/:num/memory-review', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const num = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,num) as any
  if (!chapter?.content?.trim()) return res.status(400).json({ message: '请先填写本章正文' })
  try {
    const previous = requireProgressBeforeChapter(db,novel.id,num)
    let row = db.prepare('SELECT * FROM novel_memory_reviews WHERE chapter_id=?').get(chapter.id) as any
    const reusable = row && row.context_revision === novel.context_revision && !row.reviewed_at
    let data = reusable ? JSON.parse(row.content) : {
      memory: editableMemory(previous || emptyState(),num), issues: [], notices: [], evidence: '',
      previous: previous ? renderProgress(previous,3) : '第一章，尚无前章记忆。',
    }
    if (!reusable && chapter.status === 'finalized') {
      data.memory = editableMemory(requireProgressBeforeChapter(db,novel.id,num+1)!,num)
    }
    const startedId = row?.review_id
    if (req.body?.suggest === true) {
      if (!reusable || req.body.review_id !== row.review_id) throw new ContextConflict('核对内容已变化，请重新打开本章记忆')
      const config = getLLMConfigForTask(novel,req,'finalize')
      if (!config) return res.status(400).json({ message: '请先选择整理记忆的模型，或直接手工填写' })
      data.notices = []
      const history = await chapterEvidence(novel,num,`${chapter.title} ${chapter.outline}`)
      data.evidence = history.text
      if (history.warning) data.notices.push(history.warning)
      const context = P.STORY_CONTEXT(getDoc(db,novel.id,'architecture'),getDoc(db,novel.id,'characters'),progressBeforeChapter(db,novel.id,num)) + history.text
      const [candidate, checked] = await Promise.allSettled([
        updateProgress(config,previous,num,chapter.content,{novel_id:novel.id,task:`memory:prepare:${num}`},{audit:false}),
        checkContinuity(getLLMConfigForTask(novel,req,'consistency') || config,context,chapter.content,{novel_id:novel.id,task:`memory:check:${num}`}),
      ])
      if (candidate.status === 'fulfilled') data.memory = editableMemory(candidate.value,num)
      else data.notices.push(`AI 整理未完成，保留核对草稿，可手工填写：${candidate.reason?.message || '调用失败'}`)
      data.issues = checked.status === 'fulfilled' ? checked.value : []
      if (checked.status === 'rejected') data.notices.push(`自动审校未完成，请自行核对正文：${checked.reason?.message || '调用失败'}`)
    }
    db.transaction(() => {
      assertContextRevision(db,novel.id,novel.context_revision)
      const current = db.prepare('SELECT review_id FROM novel_memory_reviews WHERE chapter_id=?').get(chapter.id) as any
      if (current?.review_id !== startedId) throw new ContextConflict('另一份核对草稿已保存，请重新打开')
      if (!reusable || req.body?.suggest === true) {
        row = { review_id:randomUUID(), context_revision:novel.context_revision }
        db.prepare(`INSERT INTO novel_memory_reviews(chapter_id,review_id,context_revision,content) VALUES (?,?,?,?)
          ON CONFLICT(chapter_id) DO UPDATE SET review_id=excluded.review_id,context_revision=excluded.context_revision,content=excluded.content,accepted_content=NULL,reviewed_by=NULL,reviewed_at=NULL`)
          .run(chapter.id,row.review_id,novel.context_revision,JSON.stringify(data))
      }
    })()
    res.json({ ...data, review_id:row.review_id, chapter_number:num })
  } catch (err: any) { res.status(err.status || 400).json({message:err.message}) }
})

router.put('/:id/chapters/:num/memory-review', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db,req.params.id,req)
  if (!novel) return res.status(404).json({message:'小说不存在或无权限'})
  const num = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(novel.id,num) as any
  if (!chapter) return res.status(404).json({message:'章节不存在'})
  try {
    const row = db.prepare('SELECT * FROM novel_memory_reviews WHERE chapter_id=?').get(chapter.id) as any
    if (!row || row.reviewed_at || row.review_id !== req.body?.review_id) throw new ContextConflict('核对草稿已变化或已确认，请重新打开')
    assertContextRevision(db,novel.id,row.context_revision)
    const previous = requireProgressBeforeChapter(db,novel.id,num)
    const progress = reviewedProgress(previous,req.body.memory,num)
    const data = JSON.parse(row.content)
    const confirmed = req.body.confirm === true
    const reviewId = randomUUID()
    db.transaction(() => {
      if (confirmed) {
        invalidateFromChapter(db,novel.id,num)
        saveProgressSnapshot(db,novel.id,num+1,progress)
        db.prepare("UPDATE novel_chapters SET status='finalized',updated_at=CURRENT_TIMESTAMP WHERE id=?").run(chapter.id)
        db.prepare('UPDATE novel_memory_reviews SET accepted_content=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE chapter_id=?')
          .run(JSON.stringify(editableMemory(progress,num)),req.user!.username,chapter.id)
      } else {
        data.memory = editableMemory(progress,num)
        db.prepare('UPDATE novel_memory_reviews SET review_id=?,content=? WHERE chapter_id=?').run(reviewId,JSON.stringify(data),chapter.id)
      }
    })()
    // 人工确认不等待外部服务；向量可单独重试，本地原文索引已随定稿生效。
    res.json(confirmed ? { message:'已按人工核对结果定稿，下一章记忆已更新', chapter_number:num, next_chapter:num+1,
      warning: novel.embedding_config ? '向量索引待更新，可点击「重试索引」；历史原文检索已可用。' : '' }
      : { ...data, review_id:reviewId, chapter_number:num, message:'核对草稿已保存' })
  } catch (err: any) { res.status(err.status || 400).json({message:err.message}) }
})

// 兼容现有脚本的自动定稿接口；页面使用上方人工核对流程。
// ---------- POST /:id/generate/finalize/:num ----------

router.post('/:id/generate/finalize/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'finalize')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'finalize')

  const chapterNum = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || !chapter.content.trim()) return res.status(400).json({ message: '章节不存在或内容为空，请先生成' })

  try {
    const ctx = { novel_id: novel.id, task: `finalize:${chapterNum}` }

    const existing = requireProgressBeforeChapter(db, novel.id, chapterNum)
    const history = await chapterEvidence(novel, chapterNum, `${chapter.title} ${chapter.outline}`)
    const context = P.STORY_CONTEXT(getDoc(db, novel.id, 'architecture'), getDoc(db, novel.id, 'characters'), progressBeforeChapter(db, novel.id, chapterNum)) + history.text
    const issues = await checkContinuity(getLLMConfigForTask(novel, req, 'consistency') || config, context, chapter.content,
      { novel_id: novel.id, task: `continuity:finalize:${chapterNum}` })
    if (issues.length) throw new ContinuityConflict(issues)
    const progress = await updateProgress(config, existing, chapterNum, chapter.content, ctx)
    db.transaction(() => {
      assertContextRevision(db, novel.id, novel.context_revision)
      // 重定稿也会改变状态，所以后续快照需要顺序重建。
      invalidateFromChapter(db, novel.id, chapterNum)
      saveProgressSnapshot(db, novel.id, chapterNum + 1, progress)
      db.prepare("UPDATE novel_chapters SET status = 'finalized', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(chapter.id)
    })()

    // 进度与定稿状态已经原子提交；索引失败可单独重试，不再调用进度模型。
    let warning = ''
    const committed = db.prepare('SELECT * FROM novels WHERE id = ?').get(novel.id) as any
    try {
      if (committed.embedding_config) await indexChapter(db, committed, chapter)
    } catch (err: any) {
      warning = err instanceof ContextConflict
        ? '处理期间正文或故事进度已变化，索引未更新，请以当前章节状态为准。'
        : `章节已定稿，索引待更新（${err.message}）。检查 Embedding 配置后点击「重试索引」。`
    }

    res.json({ message: '章节终稿完成', warning })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `终稿处理失败: ${err.message}` })
  }
})

router.post('/:id/chapters/:num/reindex', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const chapterNum = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || chapter.status !== 'finalized') return res.status(409).json({ message: '请先定稿本章，再更新索引' })
  try {
    requireProgressBeforeChapter(db, novel.id, chapterNum + 1)
    await indexChapter(db, novel, chapter)
    res.json({ message: '索引更新完成' })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `索引更新失败：${err.message}` })
  }
})

// ---------- doc/chapter CRUD ----------

router.get('/:id/docs', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const docs = db.prepare("SELECT doc_type, content FROM novel_docs WHERE novel_id = ? AND doc_type != 'progress'").all(novel.id)
  const map: Record<string, string> = {}
  for (const d of docs as any[]) map[d.doc_type] = d.content
  res.json(map)
})

router.get('/:id/progress-snapshots', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  res.json(listProgressSnapshots(db, novel.id))
})

// latest 必须在 :num 之前注册，避免触发章节号参数校验。
router.get('/:id/progress-snapshots/latest', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  try { res.json(getProgressSnapshot(db, novel.id)) }
  catch (err: any) { res.status(err.status || 500).json({ message: err.message }) }
})

router.get('/:id/progress-snapshots/:num', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  try { res.json(getProgressSnapshot(db, novel.id, Number(req.params.num))) }
  catch (err: any) { res.status(err.status || 500).json({ message: err.message }) }
})

router.put('/:id/docs/:type', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  if (req.params.type === 'progress') return res.status(400).json({ message: '故事进度由定稿生成，不能直接编辑' })
  const content = req.body.content || ''
  db.transaction(() => {
    const changed = getDoc(db, novel.id, req.params.type) !== content
    saveDoc(db, novel.id, req.params.type, content)
    if (changed && ['architecture', 'characters'].includes(req.params.type)) invalidateFromChapter(db, novel.id, 1, true)
  })()
  res.json({ message: 'ok' })
})

router.get('/:id/chapters', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const chapters = db.prepare('SELECT id, chapter_number, title, status, index_status, word_count, updated_at FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number').all(novel.id)
  res.json(chapters)
})

router.get('/:id/export', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  res.json(db.prepare('SELECT chapter_number, title, content FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number').all(novel.id))
})

router.get('/:id/chapters/:num', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, Number(req.params.num))
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  res.json(chapter)
})

router.put('/:id/chapters/:num', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const { title, content, outline } = req.body
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  if (content !== undefined && typeof content !== 'string') return res.status(400).json({ message: '正文必须是文本' })
  if (outline !== undefined && (typeof outline !== 'string' || outline.length>50000)) return res.status(400).json({message:'台本必须是文本，最多 50000 字'})
  if (outline !== undefined && req.body.outline_revision !== undefined && req.body.outline_revision !== chapter.outline_revision) return res.status(409).json({message:'台本已在其他窗口修改，本次输入未覆盖它，请重新载入后合并'})
  db.transaction(() => {
    db.prepare('UPDATE novel_chapters SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(title ?? chapter.title, chapter.id)
    if (title !== undefined && title !== chapter.title) bumpContextRevision(db, novel.id)
    if (outline !== undefined) writeOutline(chapter,outline)
    if (content !== undefined) saveChapterContent(db, novel.id, chapter, content)
  })()
  res.json({ message: 'ok',outline_revision:chapter.outline_revision+(outline!==undefined && outline!==chapter.outline?1:0) })
})

router.post('/:id/chapters', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  
  const { chapter_number, title, outline, content } = req.body
  if (!Number.isSafeInteger(chapter_number) || chapter_number < 1) return res.status(400).json({ message: '章节号必须是正整数' })
  if (content !== undefined && typeof content !== 'string') return res.status(400).json({ message: '正文必须是文本' })
  
  // 检查章节号是否已存在
  const existing = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapter_number)
  if (existing) {
    return res.status(400).json({ message: '章节号已存在' })
  }
  
  const chapterId = db.transaction(() => {
    const result = db.prepare(
      'INSERT INTO novel_chapters (novel_id, chapter_number, title, outline, content, status, word_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(novel.id, chapter_number, title || `第${chapter_number}章`, outline || '', content || '', 'draft', (content || '').replace(/\s/g, '').length)
    invalidateFromChapter(db, novel.id, chapter_number)
    return result.lastInsertRowid
  })()
  res.json({ message: 'ok', id: chapterId })
})

router.delete('/:id/chapters/:chapterId', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  
  const chapterId = parseInt(req.params.chapterId)
  const chapter = db.prepare('SELECT id, chapter_number FROM novel_chapters WHERE id = ? AND novel_id = ?').get(chapterId, novel.id) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  
  db.transaction(() => {
    db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(chapterId)
    invalidateFromChapter(db, novel.id, chapter.chapter_number)
  })()
  res.json({ message: 'ok' })
})

// ---------- POST /:id/review/:num ----------
// 审稿员：AI 味交给检测脚本，其余由大模型判断

router.post('/:id/review/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'consistency')
  if (!config) return res.status(400).json({ message: '请先选择审校模型的 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'consistency')

  const chapterNum = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || !chapter.content.trim()) return res.status(400).json({ message: '章节不存在或内容为空，请先生成' })

  try {
    const { review } = await reviewChapter(
      config,
      {
        chapterNum,
        content: chapter.content,
        outline: chapter.outline || '',
        worldSetting: getDoc(db, novel.id, 'architecture'),
        characters: getDoc(db, novel.id, 'characters'),
        previousSummary: progressBeforeChapter(db, novel.id, chapterNum) + (await chapterEvidence(novel, chapterNum, `${chapter.title} ${chapter.outline}`)).text,
      },
      { novel_id: novel.id, task: `review:${chapterNum}` },
    )

    assertContextRevision(db, novel.id, novel.context_revision)
    res.json({ message: '审稿完成', review })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `审稿失败: ${err.message}` })
  }
})

// ---------- POST /:id/revise/:num ----------
// 按勾选的审稿意见做补丁式修订。未勾选的意见会明确告知模型不要动。

router.post('/:id/revise/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'chapter')
  if (!config) return res.status(400).json({ message: '请先选择起草模型的 LLM 配置' })

  const chapterNum = Number(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || !chapter.content) return res.status(400).json({ message: '章节不存在或内容为空' })

  const accepted: string[] = Array.isArray(req.body?.accepted_notes) ? req.body.accepted_notes : []
  const rejected: string[] = Array.isArray(req.body?.rejected_notes) ? req.body.rejected_notes : []
  if (accepted.length === 0) return res.status(400).json({ message: '请至少勾选一条要采纳的意见' })

  try {
    requireProgressBeforeChapter(db, novel.id, chapterNum)
    const result = await revisePatchwise(
      config,
      {
        content: chapter.content,
        outline: chapter.outline || '',
        acceptedNotes: accepted,
        rejectedNotes: rejected,
        styleGuide: novel.style_guide || '',
      },
      { novel_id: novel.id, task: `revise:${chapterNum}` },
    )

    if (result.raw) {
      return res.status(500).json({ message: '补丁解析失败，未改动原稿', raw: result.raw })
    }
    if (result.applied.length === 0) {
      return res.json({
        message: '没有任何补丁生效，原稿未改动',
        applied: [], failed: result.failed, word_delta: 0,
      })
    }

    const wordCount = result.content.replace(/\s/g, '').length
    db.transaction(() => {
      assertContextRevision(db, novel.id, novel.context_revision)
      saveChapterContent(db, novel.id, chapter, result.content, `修订前存档（采纳 ${accepted.length} 条意见）`)
    })()

    res.json({
      message: `修订完成，${result.applied.length} 条补丁生效`,
      applied: result.applied,
      failed: result.failed,
      word_delta: result.wordDelta,
      word_count: wordCount,
    })
  } catch (err: any) {
    res.status(err.status || 500).json({ message: `修订失败: ${err.message}` })
  }
})

// ---------- 章节版本历史 ----------

router.get('/:id/chapters/:num/revisions', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const chapter = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })

  res.json(db.prepare(
    'SELECT id, word_count, note, created_at FROM chapter_revisions WHERE chapter_id = ? ORDER BY created_at DESC'
  ).all(chapter.id))
})

router.get('/:id/chapters/:num/revisions/:revisionId', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const chapter = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })

  const revision = db.prepare('SELECT * FROM chapter_revisions WHERE id = ? AND chapter_id = ?').get(parseInt(req.params.revisionId), chapter.id)
  if (!revision) return res.status(404).json({ message: '版本不存在' })
  res.json(revision)
})

router.post('/:id/chapters/:num/revisions/:revisionId/revert', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, Number(req.params.num)) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })

  const revision = db.prepare('SELECT * FROM chapter_revisions WHERE id = ? AND chapter_id = ?').get(parseInt(req.params.revisionId), chapter.id) as any
  if (!revision) return res.status(404).json({ message: '版本不存在' })

  db.transaction(() => {
    saveChapterContent(db, novel.id, chapter, revision.content, '回退前存档')
  })()

  res.json({ message: '已回退到所选版本', word_count: revision.word_count })
})

// ---------- LLM Call Logs ----------

router.get('/:id/llm-logs', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const limit = parseInt(req.query.limit as string) || 100
  const logs = getLogsByNovelId(novel.id, limit)
  res.json(logs)
})

router.delete('/:id/llm-logs', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  clearLogsByNovelId(novel.id)
  res.json({ message: '日志已清空' })
})

export default router
