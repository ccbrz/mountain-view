import Database from 'better-sqlite3'
import { getLLMConfigByName } from '../llm/config'
import { reviewChapter } from '../llm/review'
import { progressBeforeChapter } from '../llm/doc-snapshots'
import fs from 'fs'
import path from 'path'

// 同一份正文审 N 次，看审稿员自身波动。argv[2] 可指定正文文件，默认库里当前正文
async function main() {
  const db = new Database(process.env.DB_PATH || path.resolve(__dirname, '../../../data/app.db'), { readonly: true })
  const ch = db.prepare(`SELECT c.outline, c.content, c.novel_id FROM novel_chapters c WHERE c.chapter_number = 1`).get() as any
  const docMap: Record<string, string> = {}
  for (const d of db.prepare('SELECT doc_type, content FROM novel_docs WHERE novel_id = ?').all(ch.novel_id) as any[]) docMap[d.doc_type] = d.content
  const prior = { characters: docMap.characters || '', summary: progressBeforeChapter(db, ch.novel_id, 1) }
  db.close()
  const content = process.argv[2] ? fs.readFileSync(process.argv[2], 'utf8') : ch.content
  const cfg = getLLMConfigByName('ds-v4-flash')!
  const runs = await Promise.allSettled([1, 2, 3, 4, 5].map((i) => reviewChapter(cfg, {
    chapterNum: 1, content, outline: ch.outline, worldSetting: docMap.architecture || '', characters: prior.characters, previousSummary: prior.summary,
  }, { novel_id: ch.novel_id, task: `exp-noise:${i}` })))
  for (const r of runs) {
    if (r.status === 'rejected') { console.log('失败', r.reason?.message); continue }
    const v = r.value.review
    console.log(`${v.total} ${JSON.stringify(v.scores)} ${v.verdict}`)
    console.log(`   情节点 ${v.beats.map((b) => b.status).join(' ')} | ${v.issues.map((it) => `${it.severity}·${it.dimension}`).join('，')}`)
  }
}
main()
