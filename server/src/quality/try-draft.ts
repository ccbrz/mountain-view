import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigs, getLLMConfigByName } from '../llm/config'
import { invokeWithRetry, extractChapterBody } from '../llm/invoke'
import * as P from '../llm/prompts'
import { progressBeforeChapter } from '../llm/doc-snapshots'
import { measureText } from './detectors'

/**
 * 验证篇幅控制：用新 prompt 重新起草，和库里的旧稿比字数。
 * 复刻 novel-generator 里第一章的上下文拼装（向量库为空、无前章摘要，所以可精确复刻）。
 * 只读数据库，结果写 demo-output/。
 *
 * 用法：npx tsx src/quality/try-draft.ts [chapterNumber] [configName]
 */

const chapterNum = parseInt(process.argv[2] || '1')
const configName = process.argv[3]
const OUT_DIR = path.join(__dirname, '../../../demo-output')

async function main() {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/app.db')
  const db = new Database(DB_PATH, { readonly: true })

  const chapter = db.prepare(
    `SELECT c.chapter_number, c.title, c.outline, c.content, n.id AS novel_id,
            n.word_number, n.style_guide, n.style_reference
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id WHERE c.chapter_number = ?`
  ).get(chapterNum) as any
  if (!chapter) throw new Error(`第 ${chapterNum} 章不存在`)

  const docs = db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(chapter.novel_id) as any[]
  const docMap: Record<string, string> = {}
  for (const d of docs) docMap[d.doc_type] = d.content
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, chapter.novel_id, chapterNum) }
  db.close()

  const targetWords = chapter.word_number || 2000

  // —— 复刻路由里的上下文拼装 ——
  let context = P.STORY_CONTEXT(docMap.architecture || '', prior.characters, prior.summary)
  if (chapter.outline) context += `\n=== 本章台本 ===\n${chapter.outline}\n`

  const isFirst = chapterNum === 1
  const systemPrompt = P.draftSystemPrompt(isFirst, chapter.style_guide || '', targetWords)
  const userPrompt = isFirst
    ? P.USER_FIRST_CHAPTER(context, chapter.style_reference || '')
    : P.USER_CHAPTER_DRAFT(`当前是第 ${chapterNum} 章：${chapter.title}\n\n${context}`, chapter.style_reference || '')

  const config = configName ? getLLMConfigByName(configName) : getLLMConfigs()[0]
  if (!config) throw new Error('没有可用的 LLM 配置')

  console.log(`配置：${config.name}（${config.model_name}）`)
  console.log(`台本 ${(chapter.outline || '').length} 字 → 目标 ${targetWords} 字`)
  console.log(`prompt 里的篇幅要求：\n${P.LENGTH_BRIEF(targetWords)}\n`)
  console.log('起草中...\n')

  const t = Date.now()
  const content = extractChapterBody(await invokeWithRetry(config, systemPrompt, userPrompt, 3,
    { novel_id: chapter.novel_id, task: `try-draft:${chapterNum}` }))

  const fresh = measureText(content, { targetWords })
  const old = chapter.content ? measureText(chapter.content, { targetWords }) : null

  console.log('═'.repeat(64))
  console.log(`耗时 ${((Date.now() - t) / 1000).toFixed(0)}s`)
  const row = (name: string, a: any, b: any) =>
    console.log(`  ${name.padEnd(20)} ${String(a).padStart(9)}  →  ${String(b).padStart(9)}`)
  console.log(`  ${'指标'.padEnd(20)} ${'旧稿'.padStart(9)}     ${'新稿'.padStart(9)}`)
  if (old) {
    row('字数', old.wordCount, fresh.wordCount)
    row('偏离目标', `${(old.lengthDeviation! * 100).toFixed(0)}%`, `${(fresh.lengthDeviation! * 100).toFixed(0)}%`)
    row('模板化明喻', old.measurements.find((m) => m.id === 'simile-template')?.count, fresh.measurements.find((m) => m.id === 'simile-template')?.count)
    row('动作后补充解释', old.measurements.find((m) => m.id === 'explain-tail')?.count, fresh.measurements.find((m) => m.id === 'explain-tail')?.count)
    row('套路化表达', old.measurements.find((m) => m.id === 'cliche')?.count, fresh.measurements.find((m) => m.id === 'cliche')?.count)
    row('叙述语数字/千字', old.measurements.find((m) => m.id === 'numeric-narration')?.perK, fresh.measurements.find((m) => m.id === 'numeric-narration')?.perK)
    row('短句占比', (old.shortSentenceRatio * 100).toFixed(0) + '%', (fresh.shortSentenceRatio * 100).toFixed(0) + '%')
  } else {
    console.log(`  新稿 ${fresh.wordCount} 字（目标 ${targetWords}）`)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `ch${chapterNum}-06-新prompt起草.md`)
  fs.writeFileSync(out, content)
  console.log(`\n新稿已写入 ${out}`)
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
