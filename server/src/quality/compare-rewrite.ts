import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import { getLLMConfigs, getLLMConfigByName } from '../llm/config'
import { invokeWithRetry } from '../llm/invoke'
import { measureText, splitSentences, countWords } from './detectors'

/**
 * 对照实验：同一份原稿 + 同一批审稿意见，比较「补丁修订」和「整章重写」。
 *
 * 核心指标是漂移率——未被点名的句子有多少被改动了。补丁方案该指标恒为 0
 * （机制保证），整章重写是多少，跑出来才知道。
 *
 * 用法：npx tsx src/quality/compare-rewrite.ts [configName]
 */

const OUT_DIR = path.join(__dirname, '../../../demo-output')
const configName = process.argv[2]

/** 整章重写的 system prompt：按最强写，约束与补丁版对齐，避免把对照组做成稻草人 */
const SYSTEM_FULL_REWRITE = `你是执行责编意见的写手。你的任务是修订，不是重写。

【最重要的规则】
没有被意见点到的段落，必须逐字保持原样输出，一个标点都不要改。
你可能会觉得某些地方还能写得更好——不要动它。作者对现有文字是满意的，
你擅自改动会破坏他的语感，这比不改更糟。

【其他规则】
1. 只处理【需要落实的意见】里点到的问题。
2. 【已知但保留的问题】列出的内容不要动，那是作者主动选择保留的。
3. 不得借修订之机添加台本之外的新剧情、新角色、新设定。
4. 修改处与前后文的衔接要通顺，注意代词和指代关系不要因为改动而错位。

输出修改后的完整章节正文，不要任何解释说明。`

const USER_FULL_REWRITE = (p: { content: string; outline: string; accepted: string[]; rejected: string[] }) =>
  `【本章台本】剧情依据，修订同样不得偏离：
${p.outline}

【需要落实的意见】逐条处理：
${p.accepted.map((n, i) => `${i + 1}. ${n}`).join('\n')}

${p.rejected.length ? `【已知但保留的问题】作者看过了，决定不改，请不要碰：\n${p.rejected.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n` : ''}
【原稿】
${p.content}

请输出修订后的完整正文。`

/** 漂移率：原稿里有多少句子在新版中原样保留 */
function driftReport(original: string, revised: string) {
  const origSentences = splitSentences(original).filter((s) => countWords(s) >= 4)
  const kept = origSentences.filter((s) => revised.includes(s))
  return {
    total: origSentences.length,
    kept: kept.length,
    changed: origSentences.length - kept.length,
    keepRate: origSentences.length ? +(kept.length / origSentences.length * 100).toFixed(1) : 0,
  }
}

async function main() {
  const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../../data/app.db')
  const db = new Database(DB_PATH, { readonly: true })
  const chapter = db.prepare(
    `SELECT c.outline, n.id AS novel_id, n.word_number
     FROM novel_chapters c JOIN novels n ON n.id = c.novel_id WHERE c.chapter_number = 1`
  ).get() as any
  db.close()

  // 原稿必须取存档文件而不是库里的当前正文——库里那份可能已经被重新生成过，
  // 而审稿意见和补丁版都是针对这份存档产生的，三者必须同源才可比。
  const original = fs.readFileSync(path.join(OUT_DIR, 'ch1-02-原稿.md'), 'utf8')
  const patched = fs.readFileSync(path.join(OUT_DIR, 'ch1-04-修订稿.md'), 'utf8')
  const review = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'ch1-03-审稿意见.json'), 'utf8'))

  const accepted = [
    ...review.coverage.missing.map((s: string) => `【台本漏写】${s}`),
    ...review.coverage.invented.map((s: string) => `【凭空加戏，需删除】${s}`),
    ...review.issues.map((it: any) => `【${it.dimension}】${it.problem}\n   改法：${it.suggestion}`),
  ]

  const config = configName ? getLLMConfigByName(configName) : getLLMConfigs()[0]
  if (!config) throw new Error('没有可用的 LLM 配置')
  console.log(`配置：${config.name}（${config.model_name}）`)
  console.log(`原稿 ${countWords(original)} 字，意见 ${accepted.length} 条，与补丁那轮完全一致`)
  console.log('整章重写中…\n')

  const t = Date.now()
  const rewritten = await invokeWithRetry(
    { ...config, temperature: 0.3 },
    SYSTEM_FULL_REWRITE,
    USER_FULL_REWRITE({ content: original, outline: chapter.outline || '', accepted, rejected: [] }),
    3,
    { novel_id: chapter.novel_id, task: 'compare-full-rewrite' },
  )
  const elapsed = ((Date.now() - t) / 1000).toFixed(0)

  const target = chapter.word_number || 2000
  const orig = measureText(original, { targetWords: target })
  const mPatch = measureText(patched, { targetWords: target })
  const mFull = measureText(rewritten, { targetWords: target })
  const dPatch = driftReport(original, patched)
  const dFull = driftReport(original, rewritten)

  const row = (name: string, a: any, b: any, c: any) =>
    console.log(`  ${name.padEnd(20)} ${String(a).padStart(9)} ${String(b).padStart(11)} ${String(c).padStart(11)}`)

  console.log('═'.repeat(58))
  console.log(`  ${'指标'.padEnd(20)} ${'原稿'.padStart(9)} ${'补丁版'.padStart(10)} ${'整章重写'.padStart(9)}`)
  console.log('─'.repeat(58))
  row('字数', orig.wordCount, mPatch.wordCount, mFull.wordCount)
  row('段落数', orig.paragraphs, mPatch.paragraphs, mFull.paragraphs)
  row('模板化明喻', orig.measurements.find((m) => m.id === 'simile-template')?.count,
      mPatch.measurements.find((m) => m.id === 'simile-template')?.count,
      mFull.measurements.find((m) => m.id === 'simile-template')?.count)
  row('动作后补充解释', orig.measurements.find((m) => m.id === 'explain-tail')?.count,
      mPatch.measurements.find((m) => m.id === 'explain-tail')?.count,
      mFull.measurements.find((m) => m.id === 'explain-tail')?.count)
  row('套路化表达', orig.measurements.find((m) => m.id === 'cliche')?.count,
      mPatch.measurements.find((m) => m.id === 'cliche')?.count,
      mFull.measurements.find((m) => m.id === 'cliche')?.count)
  row('短句占比', (orig.shortSentenceRatio * 100).toFixed(0) + '%',
      (mPatch.shortSentenceRatio * 100).toFixed(0) + '%',
      (mFull.shortSentenceRatio * 100).toFixed(0) + '%')
  console.log('─'.repeat(58))
  row('原句保留率', '100%', dPatch.keepRate + '%', dFull.keepRate + '%')
  row('被改动的句子', 0, dPatch.changed, dFull.changed)
  console.log('═'.repeat(58))
  console.log(`  整章重写耗时 ${elapsed}s（补丁那轮 94s）`)

  fs.writeFileSync(path.join(OUT_DIR, 'ch1-07-整章重写版.md'), rewritten)
  console.log(`\n已写入 ${OUT_DIR}/ch1-07-整章重写版.md`)
}

main().catch((e) => { console.error('失败：', e.message); process.exit(1) })
