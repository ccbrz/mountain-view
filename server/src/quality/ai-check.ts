// 离线验证：检测脚本封装 + 文笔分计算，不调模型
// 用法：tsx src/quality/ai-check.ts [正文文件]，不传则读库里第一章
import fs from 'fs'
import { getDB } from '../db'
import { scanAiPatterns, groupAiFindings } from './ai-patterns'
import { parseReviewJSON } from '../llm/review'

const content = process.argv[2]
  ? fs.readFileSync(process.argv[2], 'utf8')
  : (getDB().prepare('SELECT content FROM novel_chapters WHERE id = 1').get() as any).content
const checks = groupAiFindings(scanAiPatterns(content))
console.log(checks.map((c) => `${c.severity} ${c.label}×${c.count}`).join('\n'))
const r = parseReviewJSON('{"beats":[],"issues":[],"scores":{"consistency":15,"webnovel":20}}', [], checks)
console.log('prose =', r.scores.prose, 'total =', r.total)
console.log(r.issues.at(-1)?.problem)
console.log(r.issues.at(-1)?.suggestion)
