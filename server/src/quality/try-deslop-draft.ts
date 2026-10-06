import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigs, getLLMConfigByName } from '../llm/config'
import { invokeWithRetry, extractChapterBody } from '../llm/invoke'
import * as P from '../llm/prompts'
import { progressBeforeChapter } from '../llm/doc-snapshots'
import { scanAiPatterns, groupAiFindings, AiCheck } from './ai-patterns'

/**
 * 用当前起草 prompt（含扩写后的 ANTI_AI_WRITING）重新起草，和库里的稿子比 AI 味检测命中。
 * 只读数据库，新稿写 demo-output/。
 *
 * 用法：tsx src/quality/try-deslop-draft.ts [chapterNumber] [configName]
 */

const chapterNum = parseInt(process.argv[2] || '1')
const configName = process.argv[3]
const OUT_DIR = path.join(__dirname, '../../../demo-output')

const prose = (checks: AiCheck[]) =>
  Math.max(0, 25 - checks.reduce((s, c) => s + (c.severity === 'blocking' ? 5 : 2), 0))

async function main() {
  const db = new Database(path.join(__dirname, '../../../data/app.db'), { readonly: true })
  const chapter = db.prepare(
    `SELECT c.chapter_number, c.title, c.outline, c.content, n.id AS novel_id,
            n.word_number, n.style_guide, n.style_reference
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id WHERE c.chapter_number = ?`
  ).get(chapterNum) as any
  if (!chapter) throw new Error(`第 ${chapterNum} 章不存在`)
  const docMap: Record<string, string> = {}
  for (const d of db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(chapter.novel_id) as any[])
    docMap[d.doc_type] = d.content
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, chapter.novel_id, chapterNum) }
  db.close()

  const targetWords = chapter.word_number || 2000
  let context = P.STORY_CONTEXT(docMap.architecture || '', prior.characters, prior.summary)
  if (chapter.outline) context += `\n=== 本章台本 ===\n${chapter.outline}\n`
  const isFirst = chapterNum === 1
  const systemPrompt = P.draftSystemPrompt(isFirst, chapter.style_guide || '', targetWords)
  const userPrompt = isFirst
    ? P.USER_FIRST_CHAPTER(context, chapter.style_reference || '')
    : P.USER_CHAPTER_DRAFT(`当前是第 ${chapterNum} 章：${chapter.title}\n\n${context}`, chapter.style_reference || '')

  const config = configName ? getLLMConfigByName(configName) : getLLMConfigs()[0]
  if (!config) throw new Error('没有可用的 LLM 配置')
  console.log(`配置：${config.name}（${config.model_name}），起草中...`)

  const t = Date.now()
  const content = extractChapterBody(await invokeWithRetry(config, systemPrompt, userPrompt, 3,
    { novel_id: chapter.novel_id, task: `try-deslop-draft:${chapterNum}` }))
  console.log(`耗时 ${((Date.now() - t) / 1000).toFixed(0)}s\n`)

  const oldChecks = groupAiFindings(scanAiPatterns(chapter.content || ''))
  const newChecks = groupAiFindings(scanAiPatterns(content))
  const types = [...new Set([...oldChecks, ...newChecks].map((c) => c.type))]
  const find = (cs: AiCheck[], t: string) => cs.find((c) => c.type === t)

  console.log(`${'类型'.padEnd(34)}${'级别'.padEnd(10)}旧稿  新稿`)
  for (const type of types) {
    const c = find(newChecks, type) || find(oldChecks, type)!
    console.log(`${`${c.label}(${type})`.padEnd(34)}${c.severity.padEnd(10)}${String(find(oldChecks, type)?.count ?? 0).padStart(4)}  ${String(find(newChecks, type)?.count ?? 0).padStart(4)}`)
  }
  const count = (s: string) => `${s.replace(/\s/g, '').length}（汉字 ${(s.match(/[\u4e00-\u9fff]/g) || []).length}）`
  console.log(`\n字数（不含空白）  ${count(chapter.content || '')} → ${count(content)}，目标 ${targetWords}`)
  console.log(`prose 分    ${prose(oldChecks)} → ${prose(newChecks)}`)

  for (const c of newChecks) {
    console.log(`\n[新稿] ${c.label}×${c.count}：${c.message}`)
    for (const e of c.excerpts.slice(0, 3)) console.log(`   · ${e}`)
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `ch${chapterNum}-${process.env.TAG || "10"}-篇幅进SP起草.md`)
  fs.writeFileSync(out, content)
  console.log(`\n新稿已写入 ${out}`)
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
