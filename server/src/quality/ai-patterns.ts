/**
 * AI 味检测：调用 oh-story 的 check-ai-patterns.js（server/vendor/oh-story，原样拷贝）。
 * 纯正则、确定性，同一段正文每次结果一样。审稿的文笔分由它算，不交给模型主观判断。
 */

import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { scanLocalPatterns } from './local-patterns'

// src/quality 与 dist/quality 往上两级都是 server/
const SCRIPT = path.resolve(__dirname, '../../vendor/oh-story/check-ai-patterns.js')

export interface AiFinding {
  line: number
  column: number
  type: string
  severity: 'blocking' | 'advisory'
  message: string
  excerpt: string
}

/** 按类型汇总，文笔分按类型扣 */
export interface AiCheck {
  type: string
  label: string
  severity: 'blocking' | 'advisory'
  count: number
  message: string
  excerpts: string[]
}

const LABELS: Record<string, string> = {
  'not-is-comparison': '不是A而是B',
  'reverse-not-is': '反序对比',
  'negation-parade': '否定排比',
  'voice-contrast': '音量反差腔',
  'em-dash': '破折号',
  'trailer-ending': '预告式收尾',
  'trailer-summary': '章尾总结体',
  'long-paragraph': '长段落',
  'period-stutter': '碎句号',
  'formulaic-parallelism': '工整并列',
  'quote-emphasis-tic': '引号强调',
  'micro-action-tic': '微动作复读',
  'stock-reaction-tic': '套式反应',
  'action-list-tic': '动作清单',
  'cliche-density-tic': '套词密度',
  'metaphor-density-tic': '比喻密度',
  'reasoning-chain-tic': '解释链',
  'system-notice-formality-tic': '系统公告腔',
  'overcompressed-prose-tic': '过度精炼',
  'low-connective-density-tic': '低连接密度',
  'abstract-summary-tic': '抽象总结',
  // 以下是 local-patterns.ts 自己补的
  'physio-reaction': '生理反应',
  'feel-tell': '直说感受',
  'explain-tail': '解释补句',
  'simile-count': '比喻过多',
  'lyric-ending': '抒情收尾',
}

export function scanAiPatterns(text: string): AiFinding[] {
  return [...scanVendorPatterns(text), ...scanLocalPatterns(text)]
}

function scanVendorPatterns(text: string): AiFinding[] {
  // 脚本只收文件路径；临时目录里没有 .deslop-whitelist，白名单为空
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-patterns-'))
  try {
    const file = path.join(dir, 'chapter.txt')
    fs.writeFileSync(file, text, 'utf8')
    const r = spawnSync(process.execPath, [SCRIPT, '--json', file], { encoding: 'utf8', maxBuffer: 16 << 20 })
    // 有命中时 exit 1 是正常的，2 才是读文件失败
    if (r.error || (r.status !== 0 && r.status !== 1)) {
      throw new Error(`AI 味检测失败：${r.error?.message || r.stderr || `exit ${r.status}`}`)
    }
    return JSON.parse(r.stdout).findings.map(({ file: _f, ...f }: any) => f)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

export function groupAiFindings(findings: AiFinding[]): AiCheck[] {
  const map = new Map<string, AiCheck>()
  for (const f of findings) {
    const c = map.get(f.type)
    if (c) {
      c.count++
      c.excerpts.push(f.excerpt)
    } else {
      map.set(f.type, {
        type: f.type,
        label: LABELS[f.type] || f.type,
        severity: f.severity,
        count: 1,
        message: f.message,
        excerpts: [f.excerpt],
      })
    }
  }
  // blocking 在前
  return [...map.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'blocking' ? -1 : 1))
}
