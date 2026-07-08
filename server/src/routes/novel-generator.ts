import { Router } from 'express'
import { getDB } from '../db'
import { authenticate, AuthRequest } from '../middleware/auth'
import { getLLMConfigs, getLLMConfigByName, LLMConfig } from '../llm/config'
import { invokeWithRetry } from '../llm/invoke'
import * as P from '../llm/prompts'
import { getVectorStore } from '../llm/vectorstore'
import { addLLMCallLog, getLogsByNovelId, clearLogsByNovelId } from '../llm/logstore'

const router = Router()

// ---------- helpers ----------

function getNovelOrForbid(db: any, id: string, req: AuthRequest) {
  const novel = db.prepare('SELECT * FROM novels WHERE id = ?').get(id) as any
  if (!novel) return null
  const isAdmin = req.user?.role === 'admin'
  const isCreator = novel.creator_username === req.user!.username
  if (!isAdmin && !isCreator) return null
  return novel
}

const TASKS = ['architecture', 'blueprint', 'chapter', 'finalize', 'consistency', 'rerank'] as const
type TaskType = typeof TASKS[number]

function getLLMConfigForTask(novel: any, req: AuthRequest, task: TaskType): LLMConfig | null {
  let configName = ''
  if (novel.llm_config) {
    try {
      if (novel.llm_config.startsWith('{')) {
        const map = JSON.parse(novel.llm_config)
        if (map[task]) configName = map[task]
        else {
          for (const t of TASKS) {
            if (map[t]) { configName = map[t]; break }
          }
        }
      } else {
        configName = novel.llm_config
      }
    } catch {
      if (typeof novel.llm_config === 'string' && novel.llm_config.length > 0) {
        configName = novel.llm_config
      }
    }
  }
  if (!configName) configName = req.body?.llm_config || ''
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

function parseBlueprintChapters(db: any, novelId: number, content: string, fallbackCount: number) {
  const lines = content.split('\n')
  let chapterNum = 0
  for (const line of lines) {
    const m = line.match(/^(?:第\s*)?(\d+)\s*(?:章|节)?[.、．\s]*\s*(.+)$/)
    if (m) {
      chapterNum++
      const title = m[2].trim()
      const existing = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novelId, chapterNum)
      if (!existing) {
        db.prepare('INSERT INTO novel_chapters (novel_id, chapter_number, title) VALUES (?, ?, ?)').run(novelId, chapterNum, title)
      }
    }
  }
  if (chapterNum === 0) {
    for (let i = 1; i <= fallbackCount; i++) {
      const existing = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novelId, i)
      if (!existing) {
        db.prepare('INSERT INTO novel_chapters (novel_id, chapter_number, title) VALUES (?, ?, ?)').run(novelId, i, `第${i}章`)
      }
    }
  }
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
    const truncated = content.length > 15000
      ? content.slice(0, 15000) + '\n\n[... 内容过长，已截取前 15000 字]'
      : content

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
    res.status(500).json({ message: `文风提取失败: ${err.message}` })
  }
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

  try {
    const userInput = req.body?.user_input || ''
    const ctx = { novel_id: novel.id, task: 'architecture' }
    const steps = [
      { type: 'core_seed', system: P.SYSTEM_CORE_SEED, user: P.USER_CORE_SEED({ topic: novel.title, genre: novel.genre, guidance: novel.guidance, userInput }) },
    ]

    const results: { type: string; content: string }[] = []

    for (const step of steps) {
      const content = await invokeWithRetry(config, step.system, step.user, 3, ctx)
      results.push({ type: step.type, content })
    }

    const coreSeed = results[0].content

    const charsContent = await invokeWithRetry(config, P.SYSTEM_CHARACTERS, P.USER_CHARACTERS(coreSeed), 3, ctx)
    results.push({ type: 'characters', content: charsContent })

    const combinedForWorld = `${coreSeed}\n\n${charsContent}`
    const worldContent = await invokeWithRetry(config, P.SYSTEM_WORLD_BUILDING, P.USER_WORLD_BUILDING(combinedForWorld), 3, ctx)
    results.push({ type: 'worldbuilding', content: worldContent })

    const fullContext = `${coreSeed}\n\n${charsContent}\n\n${worldContent}`
    const plotContent = await invokeWithRetry(config, P.SYSTEM_PLOT_ARCHITECTURE, P.USER_PLOT_ARCHITECTURE(fullContext), 3, ctx)
    results.push({ type: 'plot', content: plotContent })

    const architectureJoined = results.map((r) => `=== ${r.type} ===\n${r.content}`).join('\n\n')
    saveDoc(db, novel.id, 'architecture', architectureJoined)

    const charState = await invokeWithRetry(config, P.SYSTEM_CHARACTER_STATE, `请根据以下角色设定创建初始角色状态：\n\n${charsContent}`, 3, ctx)
    saveDoc(db, novel.id, 'characters', charState)

    updateNovelStatus(db, novel.id, 'architecture_done')

    res.json({ message: '架构生成完成', results })
  } catch (err: any) {
    res.status(500).json({ message: `架构生成失败: ${err.message}` })
  }
})

// ---------- POST /:id/generate/blueprint ----------

router.post('/:id/generate/blueprint', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'blueprint')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'blueprint')

  const architecture = getDoc(db, novel.id, 'architecture')
  if (!architecture) return res.status(400).json({ message: '请先生成小说架构' })

  try {
    const ctx = { novel_id: novel.id, task: 'blueprint' }
    const content = await invokeWithRetry(config, P.SYSTEM_CHAPTER_BLUEPRINT, P.USER_CHAPTER_BLUEPRINT(architecture, novel.num_chapters || 10), 3, ctx)
    saveDoc(db, novel.id, 'blueprint', content)
    parseBlueprintChapters(db, novel.id, content, novel.num_chapters || 10)
    updateNovelStatus(db, novel.id, 'blueprint_done')

    res.json({ message: '蓝图生成完成', content })
  } catch (err: any) {
    res.status(500).json({ message: `蓝图生成失败: ${err.message}` })
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

  const chapterNum = parseInt(req.params.num)
  if (isNaN(chapterNum)) return res.status(400).json({ message: '章节号无效' })

  // ensure chapter record exists
  let chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter) {
    db.prepare('INSERT INTO novel_chapters (novel_id, chapter_number, title) VALUES (?, ?, ?)').run(novel.id, chapterNum, `第${chapterNum}章`)
    chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  }

  const architecture = getDoc(db, novel.id, 'architecture')
  const summary = getDoc(db, novel.id, 'summary')
  const charState = getDoc(db, novel.id, 'characters')
  const outline = chapter.outline || ''

  try {
    const chapterCtx = { novel_id: novel.id, task: `chapter:${chapterNum}` }
    let context = `=== 小说架构 ===\n${architecture}\n`
    if (summary) context += `\n=== 全局摘要 ===\n${summary}\n`
    if (charState) context += `\n=== 角色状态 ===\n${charState}\n`
    if (outline) context += `\n=== 本章台本 ===\n${outline}\n`

    // 前3章摘要注入（第2章及之后）
    if (chapterNum > 1) {
      const recentChapters = db.prepare(
        'SELECT chapter_number, title, content FROM novel_chapters WHERE novel_id = ? AND chapter_number < ? AND content IS NOT NULL AND content != "" ORDER BY chapter_number DESC LIMIT 3'
      ).all(novel.id, chapterNum) as any[]
      
      if (recentChapters.length > 0) {
        const chaptersForSummary = recentChapters.reverse().map((ch: any) => ({
          num: ch.chapter_number,
          title: ch.title,
          content: ch.content
        }))
        
        const recentSummary = await invokeWithRetry(
          config, 
          P.SYSTEM_RECENT_SUMMARY, 
          P.USER_RECENT_SUMMARY(chaptersForSummary), 
          3, 
          chapterCtx
        )
        context += `\n=== 最近章节摘要 ===\n${recentSummary}\n`
      }
    }

    // === RAG：从已定稿章节中检索相关上下文 ===
    const vs = getVectorStore(novel.id)
    if (novel.embedding_config) {
      vs.setEmbeddingConfig(novel.embedding_config)
    }
    addRAGDebugLog(novel.id, '向量库状态', `文档数: ${vs.count()}`)
    if (vs.count() > 0) {
      // 1. LLM 根据当前章节大纲生成搜索关键词（人物/地点/事件/物品）
      const keywords = await invokeWithRetry(config, P.KNOWLEDGE_SEARCH_KEYWORDS, P.USER_KNOWLEDGE_SEARCH(`当前章节：${chapterNum} - ${chapter.title}\n${outline}`), 3, chapterCtx)
      addRAGDebugLog(novel.id, '1-搜索关键词', keywords)

      // 2. 向量检索：对关键词做 embedding，余弦相似度取 top-3
      const results = await vs.search(keywords, 3)
      if (results.length > 0) {
        const searchDetail = results.map((r, i) =>
          `[结果 ${i + 1}] (相似度: ${(r.score * 100).toFixed(1)}%)\n${r.text}`
        ).join('\n\n---\n\n')
        addRAGDebugLog(novel.id, '2-检索结果', searchDetail)

        // 3. 知识过滤：若有 rerank 模型则用轻量模型重排，否则按相关性阈值过滤
        const rerankConfig = getLLMConfigForTask(novel, req, 'rerank')
        const rawContext = results.map((r) => r.text).join('\n---\n')
        if (rerankConfig) {
          try {
            const filteredContext = await invokeWithRetry(
              rerankConfig,
              P.SYSTEM_KNOWLEDGE_FILTER,
              P.USER_KNOWLEDGE_FILTER_V2(keywords, rawContext, outline),
              3,
              { novel_id: novel.id, task: `rerank:${chapterNum}` }
            )
            context += '\n=== 相关上下文（已过滤）===\n' + filteredContext + '\n'
            addRAGDebugLog(novel.id, '3-过滤后上下文', filteredContext)
          } catch {
            context += '\n=== 相关上下文 ===\n' + rawContext + '\n'
          }
        } else {
          const passThreshold = 0.4
          const highScoreResults = results.filter(r => r.score >= passThreshold)
          const filteredText = highScoreResults.length > 0
            ? highScoreResults.map(r => r.text).join('\n---\n')
            : rawContext
          context += '\n=== 相关上下文 ===\n' + filteredText + '\n'
          addRAGDebugLog(novel.id, '3-分数过滤', `阈值=${passThreshold}, 通过=${highScoreResults.length}/${results.length}`)
        }
      } else {
        addRAGDebugLog(novel.id, '2-检索结果', '未检索到相关内容')
      }
    } else {
      addRAGDebugLog(novel.id, '1-搜索关键词', '向量库为空，跳过检索')
    }

    const contentBeforeDraft = chapter.content || ''
    db.prepare('UPDATE novel_chapters SET content_before_draft = ? WHERE id = ?').run(contentBeforeDraft, chapter.id)

    // 注入文风指南（AI 总结的结构化风格特征 → system prompt）
    const styleGuide = novel.style_guide || ''
    const styleGuideSection = styleGuide 
      ? `\n【文风要求】\n请严格模仿以下文风特征进行写作：\n${styleGuide}` 
      : ''

    // 注入范文片段（few-shot 展示 → user prompt）
    const styleRef = novel.style_reference || ''
    const styleRefSection = styleRef
      ? `\n\n=== 文风参考（请模仿以下范文的风格来撰写本章）===\n${styleRef}`
      : ''

    const isFirst = chapterNum === 1
    const baseSystemPrompt = isFirst ? P.SYSTEM_FIRST_CHAPTER : P.SYSTEM_CHAPTER_DRAFT
    const systemPrompt = baseSystemPrompt.replace('{styleGuide}', styleGuideSection)
    const userPrompt = isFirst
      ? P.USER_FIRST_CHAPTER(context + styleRefSection)
      : P.USER_CHAPTER_DRAFT(`当前是第 ${chapterNum} 章：${chapter.title}\n\n${context}${styleRefSection}`)

    addRAGDebugLog(novel.id, '4-最终生成上下文', userPrompt)

    const content = await invokeWithRetry(config, systemPrompt, userPrompt, 3, chapterCtx)
    let finalContent = content
    let wordCount = content.replace(/\s/g, '').length

    // 章节扩写：如果字数不足目标的70%，自动扩写
    const targetWords = novel.word_number || 2000
    if (wordCount < targetWords * 0.7) {
      try {
        const enrichSystemPrompt = P.SYSTEM_CHAPTER_DRAFT.replace('{styleGuide}', styleGuideSection)
        const enrichedContent = await invokeWithRetry(
          config,
          enrichSystemPrompt,
          P.USER_ENRICH_CHAPTER(content, targetWords),
          3,
          chapterCtx
        )
        finalContent = enrichedContent
        wordCount = enrichedContent.replace(/\s/g, '').length
      } catch (enrichErr) {
        // 扩写失败，使用原始内容
        console.error('章节扩写失败:', enrichErr)
      }
    }

    db.prepare('UPDATE novel_chapters SET content = ?, word_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      finalContent, wordCount, 'draft', chapter.id
    )

    updateNovelStatus(db, novel.id, 'in_progress')

    res.json({ message: '章节生成完成', chapter_number: chapterNum, word_count: wordCount })
  } catch (err: any) {
    res.status(500).json({ message: `章节生成失败: ${err.message}` })
  }
})

// ---------- POST /:id/generate/finalize/:num ----------

router.post('/:id/generate/finalize/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'finalize')
  if (!config) return res.status(400).json({ message: '请先选择 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'finalize')

  const chapterNum = parseInt(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || !chapter.content) return res.status(400).json({ message: '章节不存在或内容为空，请先生成' })

  try {
    const ctx = { novel_id: novel.id, task: `finalize:${chapterNum}` }

    const existingSummary = getDoc(db, novel.id, 'summary')
    const newSummary = await invokeWithRetry(config, P.SYSTEM_SUMMARY, P.USER_SUMMARY_UPDATE(chapter.content, existingSummary || '（尚无摘要）'), 3, ctx)
    saveDoc(db, novel.id, 'summary', newSummary)

    const existingCharState = getDoc(db, novel.id, 'characters')
    const newCharState = await invokeWithRetry(config, P.SYSTEM_CHARACTER_STATE, P.USER_CHARACTER_STATE_UPDATE(chapter.content, existingCharState || '（尚无角色状态）'), 3, ctx)
    saveDoc(db, novel.id, 'characters', newCharState)

    const vs = getVectorStore(novel.id)
    if (novel.embedding_config) {
      vs.setEmbeddingConfig(novel.embedding_config)
    }
    const segments = splitText(chapter.content, 500)
    for (const seg of segments) {
      await vs.insert(seg, { novel_id: novel.id, chapter: chapterNum })
    }

    db.prepare('UPDATE novel_chapters SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run('finalized', chapter.id)

    res.json({ message: '章节终稿完成' })
  } catch (err: any) {
    res.status(500).json({ message: `终稿处理失败: ${err.message}` })
  }
})

// ---------- doc/chapter CRUD ----------

router.get('/:id/docs', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const docs = db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(novel.id)
  const map: Record<string, string> = {}
  for (const d of docs as any[]) map[d.doc_type] = d.content
  res.json(map)
})

router.put('/:id/docs/:type', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  saveDoc(db, novel.id, req.params.type, req.body.content || '')

  if (req.params.type === 'blueprint') {
    parseBlueprintChapters(db, novel.id, req.body.content || '', novel.num_chapters || 10)
  }

  res.json({ message: 'ok' })
})

router.get('/:id/chapters', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
    const chapters = db.prepare('SELECT id, chapter_number, title, outline, content, status, word_count, updated_at FROM novel_chapters WHERE novel_id = ? ORDER BY chapter_number').all(novel.id)
  res.json(chapters)
})

router.get('/:id/chapters/:num', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, parseInt(req.params.num))
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  res.json(chapter)
})

router.put('/:id/chapters/:num', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  const { title, content, outline } = req.body
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, parseInt(req.params.num)) as any
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  const wordCount = content ? content.replace(/\s/g, '').length : chapter.word_count
  db.prepare('UPDATE novel_chapters SET title = ?, content = ?, outline = ?, word_count = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    title ?? chapter.title, content ?? chapter.content, outline ?? chapter.outline, wordCount, content ? 'draft' : chapter.status, chapter.id
  )
  res.json({ message: 'ok' })
})

router.post('/:id/chapters', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  
  const { chapter_number, title, outline, content } = req.body
  
  // 检查章节号是否已存在
  const existing = db.prepare('SELECT id FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapter_number)
  if (existing) {
    return res.status(400).json({ message: '章节号已存在' })
  }
  
  const result = db.prepare(
    'INSERT INTO novel_chapters (novel_id, chapter_number, title, outline, content, status, word_count) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    novel.id,
    chapter_number,
    title || `第${chapter_number}章`,
    outline || '',
    content || '',
    'draft',
    0
  )
  
  res.json({ message: 'ok', id: result.lastInsertRowid })
})

router.delete('/:id/chapters/:chapterId', authenticate, (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })
  
  const chapterId = parseInt(req.params.chapterId)
  const chapter = db.prepare('SELECT id FROM novel_chapters WHERE id = ? AND novel_id = ?').get(chapterId, novel.id)
  if (!chapter) return res.status(404).json({ message: '章节不存在' })
  
  db.prepare('DELETE FROM novel_chapters WHERE id = ?').run(chapterId)
  res.json({ message: 'ok' })
})

// ---------- POST /:id/generate/consistency/:num ----------

router.post('/:id/generate/consistency/:num', authenticate, async (req: AuthRequest, res) => {
  const db = getDB()
  const novel = getNovelOrForbid(db, req.params.id, req)
  if (!novel) return res.status(404).json({ message: '小说不存在或无权限' })

  const config = getLLMConfigForTask(novel, req, 'consistency')
  if (!config) return res.status(400).json({ message: '请先选择审校模型的 LLM 配置' })

  saveLLMConfig(db, novel.id, req, 'consistency')

  const chapterNum = parseInt(req.params.num)
  const chapter = db.prepare('SELECT * FROM novel_chapters WHERE novel_id = ? AND chapter_number = ?').get(novel.id, chapterNum) as any
  if (!chapter || !chapter.content) return res.status(400).json({ message: '章节不存在或内容为空，请先生成' })

  const architecture = getDoc(db, novel.id, 'architecture')
  const charState = getDoc(db, novel.id, 'characters')
  const globalSummary = getDoc(db, novel.id, 'summary')

  try {
    const ctx = { novel_id: novel.id, task: `consistency:${chapterNum}` }
    
    const result = await invokeWithRetry(
      config,
      P.SYSTEM_CONSISTENCY_CHECK,
      P.USER_CONSISTENCY_CHECK(
        architecture || '（无架构信息）',
        charState || '（无角色状态）',
        globalSummary || '（无全局摘要）',
        chapter.content
      ),
      3,
      ctx
    )

    res.json({ 
      message: '一致性检查完成', 
      result,
      has_conflict: !result.includes('无明显冲突')
    })
  } catch (err: any) {
    res.status(500).json({ message: `一致性检查失败: ${err.message}` })
  }
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

// ---------- utility ----------

function splitText(text: string, chunkSize: number): string[] {
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize))
  }
  return chunks
}

export default router
