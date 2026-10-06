import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigs, getLLMConfigByName } from '../llm/config'
import { reviewChapter } from '../llm/review'
import { progressBeforeChapter } from '../llm/doc-snapshots'
import { revisePatchwise } from '../llm/revise'
import { measureText } from '../quality/detectors'

/**
 * 端到端演示：台本 → 原稿 → 审稿 → 补丁修订 → 对比
 * 只读数据库，不修改章节内容；结果写到 demo-output/ 供阅读。
 *
 * 用法：npx tsx src/quality/demo-flow.ts [chapterNumber] [configName]
 */

const chapterNum = parseInt(process.argv[2] || '1')
const configName = process.argv[3]
const OUT_DIR = path.join(__dirname, '../../../demo-output')

const line = (s = '') => console.log(s)
const rule = (t: string) => { line(); line('━'.repeat(72)); line(t); line('━'.repeat(72)) }

async function main() {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/app.db')
  const db = new Database(DB_PATH, { readonly: true })

  const chapter = db.prepare(
    `SELECT c.chapter_number, c.title, c.outline, c.content, n.id AS novel_id, n.word_number
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id WHERE c.chapter_number = ?`
  ).get(chapterNum) as any
  if (!chapter?.content) throw new Error(`第 ${chapterNum} 章没有正文`)

  const docs = db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(chapter.novel_id) as any[]
  const docMap: Record<string, string> = {}
  for (const d of docs) docMap[d.doc_type] = d.content
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, chapter.novel_id, chapterNum) }
  db.close()

  const config = configName ? getLLMConfigByName(configName) : getLLMConfigs()[0]
  if (!config) throw new Error('没有可用的 LLM 配置')

  rule('① 章节台本（作者手写，剧情主干）')
  line(chapter.outline)

  const before = measureText(chapter.content, { targetWords: chapter.word_number })
  rule('② 原稿')
  line(`${before.wordCount} 字（目标 ${chapter.word_number}）｜${before.paragraphs} 段｜短句占比 ${(before.shortSentenceRatio * 100).toFixed(0)}%`)
  line(`模板化明喻 ${before.measurements.find((m) => m.id === 'simile-template')?.count} 处｜` +
       `动作后补充解释 ${before.measurements.find((m) => m.id === 'explain-tail')?.count} 处`)

  // ---- 审稿 ----
  line('\n审稿中...')
  const t1 = Date.now()
  const { review } = await reviewChapter(config, {
    chapterNum,
    content: chapter.content,
    outline: chapter.outline || '',
    worldSetting: docMap.architecture || '',
    characters: prior.characters,
    previousSummary: prior.summary,
  }, { novel_id: chapter.novel_id, task: `demo-review:${chapterNum}` })

  rule(`③ 审稿意见（${((Date.now() - t1) / 1000).toFixed(0)}s）`)
  line(`结论：${review.verdict === 'pass' ? '可定稿' : '建议修改'}  ${review.total} 分`)
  line(review.summary)
  line(`\n[修改意见] ${review.issues.length} 条`)
  review.issues.forEach((it, i) => line(`  ${i + 1}. [${it.severity}·${it.dimension}] ${it.problem}`))

  // 演示里全部采纳
  const acceptedNotes = [
    ...review.issues.map((it) => `【${it.dimension}】${it.problem}\n   改法：${it.suggestion}`),
  ]

  // ---- 补丁修订 ----
  line('\n生成补丁中...')
  const t2 = Date.now()
  const result = await revisePatchwise(config, {
    content: chapter.content,
    outline: chapter.outline || '',
    acceptedNotes,
    rejectedNotes: [],
  }, { novel_id: chapter.novel_id, task: `demo-revise:${chapterNum}` })

  rule(`④ 补丁应用结果（${((Date.now() - t2) / 1000).toFixed(0)}s）`)
  if (result.raw) {
    line('补丁解析失败，模型原始输出：')
    line(result.raw.slice(0, 1500))
    return
  }
  line(`成功 ${result.applied.length} 条｜失败 ${result.failed.length} 条｜净变化 ${result.wordDelta > 0 ? '+' : ''}${result.wordDelta} 字`)

  result.applied.forEach((p, i) => {
    line(`\n  [${i + 1}] ${p.note}`)
    line(`      删：${p.find.slice(0, 70).replace(/\n/g, ' ')}${p.find.length > 70 ? '…（共 ' + p.find.length + ' 字）' : ''}`)
    line(`      改：${p.replace ? p.replace.slice(0, 70).replace(/\n/g, ' ') + (p.replace.length > 70 ? '…（共 ' + p.replace.length + ' 字）' : '') : '（整段删除）'}`)
  })
  if (result.failed.length) {
    line('\n  未生效：')
    result.failed.forEach((f) => line(`      · [${f.reason}] ${f.patch.note}`))
  }

  const after = measureText(result.content, { targetWords: chapter.word_number })
  rule('⑤ 修订前后对比')
  const row = (name: string, a: any, b: any) =>
    line(`  ${name.padEnd(22)} ${String(a).padStart(8)}  →  ${String(b).padStart(8)}`)
  row('字数', before.wordCount, after.wordCount)
  row('段落数', before.paragraphs, after.paragraphs)
  row('模板化明喻', before.measurements.find((m) => m.id === 'simile-template')?.count, after.measurements.find((m) => m.id === 'simile-template')?.count)
  row('动作后补充解释', before.measurements.find((m) => m.id === 'explain-tail')?.count, after.measurements.find((m) => m.id === 'explain-tail')?.count)
  row('套路化表达', before.measurements.find((m) => m.id === 'cliche')?.count, after.measurements.find((m) => m.id === 'cliche')?.count)
  row('叙述语数字/千字', before.measurements.find((m) => m.id === 'numeric-narration')?.perK, after.measurements.find((m) => m.id === 'numeric-narration')?.perK)
  row('对话数字/千字', before.measurements.find((m) => m.id === 'numeric-dialogue')?.perK, after.measurements.find((m) => m.id === 'numeric-dialogue')?.perK)
  row('短句占比', (before.shortSentenceRatio * 100).toFixed(0) + '%', (after.shortSentenceRatio * 100).toFixed(0) + '%')

  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(path.join(OUT_DIR, `ch${chapterNum}-01-台本.txt`), chapter.outline || '')
  fs.writeFileSync(path.join(OUT_DIR, `ch${chapterNum}-02-原稿.md`), chapter.content)
  fs.writeFileSync(path.join(OUT_DIR, `ch${chapterNum}-03-审稿意见.json`), JSON.stringify(review, null, 2))
  fs.writeFileSync(path.join(OUT_DIR, `ch${chapterNum}-04-修订稿.md`), result.content)
  fs.writeFileSync(path.join(OUT_DIR, `ch${chapterNum}-05-补丁明细.json`), JSON.stringify({ applied: result.applied, failed: result.failed }, null, 2))
  line(`\n全文已写入 ${OUT_DIR}/`)
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
