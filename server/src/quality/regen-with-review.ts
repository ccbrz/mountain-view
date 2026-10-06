import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigByName } from '../llm/config'
import { invokeWithRetry, extractChapterBody } from '../llm/invoke'
import { reviewChapter } from '../llm/review'
import * as P from '../llm/prompts'
import { progressBeforeChapter } from '../llm/doc-snapshots'

/**
 * 对照实验：带着审稿意见从头重新生成一章，和补丁版比审稿分。
 * 意见取 llm_call_logs 里某次审稿的原始回复（针对修订前那一稿）。
 * 同时再审一次库里当前正文（补丁版），用来看审稿员自身的分数波动。
 * 只读数据库，结果写 demo-output/。
 *
 * 用法：tsx src/quality/regen-with-review.ts <reviewLogId>
 */

const reviewLogId = process.argv[2]
const OUT_DIR = path.join(__dirname, '../../../demo-output')

async function main() {
  const db = new Database(path.join(__dirname, '../../../data/app.db'), { readonly: true })
  const chapter = db.prepare(
    `SELECT c.chapter_number, c.outline, c.content, n.id AS novel_id, n.word_number, n.style_guide, n.style_reference
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id WHERE c.chapter_number = 1`
  ).get() as any
  const docMap: Record<string, string> = {}
  for (const d of db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(chapter.novel_id) as any[]) {
    docMap[d.doc_type] = d.content
  }
  const log = db.prepare('SELECT response FROM llm_call_logs WHERE id = ?').get(reviewLogId) as any
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, chapter.novel_id, 1) }
  db.close()
  const prevReview = JSON.parse(log.response)

  // —— 复刻第一章起草的上下文拼装（同 try-draft.ts）——
  let context = P.STORY_CONTEXT(docMap.architecture || '', prior.characters, prior.summary)
  if (chapter.outline) context += `\n=== 本章台本 ===\n${chapter.outline}\n`

  const feedback = `\n\n=== 上一稿的审稿意见 ===
本章之前写过一稿，责编指出了以下问题。这次从头重写本章，务必避开这些问题；
意见里的改法与台本冲突时，以台本为准。
${prevReview.issues.map((it: any, i: number) => `${i + 1}. 【${it.severity}·${it.dimension}】${it.problem}\n   改法：${it.suggestion}`).join('\n')}`

  const systemPrompt = P.draftSystemPrompt(true, chapter.style_guide || '', chapter.word_number || 2000)
  const userPrompt = P.USER_FIRST_CHAPTER(context + feedback, chapter.style_reference || '')

  const draftCfg = getLLMConfigByName('DeepSeek V4-Pro')!
  const reviewCfg = { ...getLLMConfigByName('ds-v4-flash')!, max_tokens: 16384 }
  const reviewInput = (content: string) => ({
    chapterNum: 1, content, outline: chapter.outline || '',
    worldSetting: docMap.architecture || '', characters: prior.characters, previousSummary: prior.summary,
  })

  console.log(`意见 ${prevReview.issues.length} 条（原稿得分 ${Object.values(prevReview.scores).reduce((a: any, b: any) => a + b, 0)}）`)
  console.log('并行：带意见重新生成 + 复审当前补丁版…')
  const t = Date.now()
  const [regen, patchedReview] = await Promise.all([
    invokeWithRetry(draftCfg, systemPrompt, userPrompt, 3, { novel_id: chapter.novel_id, task: 'exp-regen:1' })
      .then(extractChapterBody),
    reviewChapter(reviewCfg, reviewInput(chapter.content), { novel_id: chapter.novel_id, task: 'exp-review-patched:1' }),
  ])
  fs.writeFileSync(path.join(OUT_DIR, 'ch1-08-带意见重新生成.md'), regen)
  console.log(`重新生成完成 ${regen.replace(/\s/g, '').length} 字，${((Date.now() - t) / 1000).toFixed(0)}s；开始审稿…`)

  const { review: regenReview } = await reviewChapter(reviewCfg, reviewInput(regen), { novel_id: chapter.novel_id, task: 'exp-review-regen:1' })

  const show = (name: string, r: any) => {
    console.log(`\n■ ${name}：${r.total} 分 ${JSON.stringify(r.scores)}  ${r.verdict}`)
    console.log(`  总评：${r.summary}`)
    r.issues.forEach((it: any, i: number) => console.log(`  ${i + 1}. [${it.severity}·${it.dimension}] ${it.problem}`))
  }
  show('补丁版（复审）', patchedReview.review)
  show('带意见重新生成', regenReview)
  fs.writeFileSync(path.join(OUT_DIR, 'ch1-08-审稿结果.json'),
    JSON.stringify({ patched: patchedReview.review, regen: regenReview }, null, 2))
  console.log(`\n总耗时 ${((Date.now() - t) / 1000).toFixed(0)}s`)
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
