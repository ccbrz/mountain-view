import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigByName, getLLMConfigs } from '../llm/config'
import { reviewChapter } from '../llm/review'
import { progressBeforeChapter } from '../llm/doc-snapshots'

/**
 * 审稿员端到端试跑。
 * 用法：npx tsx src/quality/try-review.ts [chapterNumber] [configName] [--file=正文路径]
 *
 * --file 用于审读还没入库的稿子（比如新 prompt 刚起草出来的），
 * 台本和设定仍从库里取，只把正文替换掉。
 */

const args = process.argv.slice(2)
const fileArg = args.find((a) => a.startsWith('--file='))
const positional = args.filter((a) => !a.startsWith('--'))
const chapterNum = parseInt(positional[0] || '1')
const configName = positional[1]

async function main() {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/app.db')
  const db = new Database(DB_PATH, { readonly: true })

  const chapter = db.prepare(
    `SELECT c.chapter_number, c.title, c.outline, c.content, n.id AS novel_id, n.word_number
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id
     WHERE c.chapter_number = ?`
  ).get(chapterNum) as any
  if (!chapter) throw new Error(`第 ${chapterNum} 章不存在`)

  const content = fileArg
    ? fs.readFileSync(fileArg.slice('--file='.length), 'utf8')
    : chapter.content
  if (!content) throw new Error(`第 ${chapterNum} 章没有正文`)

  const docs = db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(chapter.novel_id) as any[]
  const docMap: Record<string, string> = {}
  for (const d of docs) docMap[d.doc_type] = d.content
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, chapter.novel_id, chapterNum) }
  db.close()

  const config = configName ? getLLMConfigByName(configName) : getLLMConfigs()[0]
  if (!config) throw new Error('没有可用的 LLM 配置')
  console.log(`使用配置：${config.name}（${config.model_name}）\n审稿中...\n`)

  const started = Date.now()
  const { review } = await reviewChapter(
    config,
    {
      chapterNum,
      content,
      outline: chapter.outline || '',
      worldSetting: docMap.architecture || '',
      characters: prior.characters,
      previousSummary: prior.summary,
    },
    { novel_id: chapter.novel_id, task: `review:${chapterNum}` },
  )

  console.log('='.repeat(70))
  console.log(`结论：${review.verdict === 'pass' ? '可以定稿' : '建议修改'}  ${review.total} 分 ${JSON.stringify(review.scores)}    耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`)
  console.log(`总评：${review.summary}`)

  if (review.raw) {
    console.log('\n[解析失败] 原始输出：\n' + review.raw.slice(0, 2000))
    return
  }

  console.log(`\n【修改意见】共 ${review.issues.length} 条`)
  review.issues.forEach((it, i) => {
    console.log(`\n  ${i + 1}. [${it.severity}·${it.dimension}] ${it.problem}`)
    if (it.quote) console.log(`     原文：${it.quote}`)
    console.log(`     改法：${it.suggestion}`)
  })
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exit(1)
})
