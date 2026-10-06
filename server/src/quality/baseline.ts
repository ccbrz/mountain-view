import Database from 'better-sqlite3'
import path from 'path'
import { measureText, metricsToPromptBlock } from './detectors'

/**
 * 基线脚本：对库里已有章节跑量具，输出将要注入审稿 prompt 的数据块。
 * 用法：npx tsx src/quality/baseline.ts [chapterNumber]
 */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/app.db')
const chapterNum = parseInt(process.argv[2] || '1')

const db = new Database(DB_PATH, { readonly: true })
const chapter = db.prepare(
  `SELECT c.chapter_number, c.title, c.content, n.word_number
   FROM novel_chapters c JOIN novels n ON n.id = c.novel_id
   WHERE c.chapter_number = ?`
).get(chapterNum) as any

if (!chapter?.content) {
  console.error(`第 ${chapterNum} 章没有正文`)
  process.exit(1)
}

const metrics = measureText(chapter.content, { targetWords: chapter.word_number })
console.log(`\n第 ${chapter.chapter_number} 章 ${chapter.title}`)
console.log('='.repeat(70))
console.log(metricsToPromptBlock(metrics))
