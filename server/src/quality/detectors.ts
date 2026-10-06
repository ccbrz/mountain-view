/**
 * 文本量具：只测量，不评判。
 *
 * 设计原则——这里不输出分数、不划分严重程度、不给修改建议。
 * 「这章写得好不好」由审稿员大模型结合世界观、人物设定、台本来判断，
 * 本文件只负责提供它靠读一遍数不准的客观数据：命中计数、位置、密度、分布。
 *
 * 典型的误判本模块刻意不做：
 *   - 重复出现的比喻可能是刻意的首尾呼应，也可能是偷懒复读 → 只报重复，不下结论
 *   - 对话里的精确参数可能是人物设定（工程师、AI）→ 叙述语和对话分开计，不合并成一个判决
 *   - 章末平收可能是过渡章的有意安排 → 只报末尾原文和悬念信号位置，不判定「缺钩子」
 */

import {
  ALL_CLICHES, SIMILE_TEMPLATES, HEDGE_WORDS,
  EMOTION_TELLING, EXPLAIN_TAIL,
} from './lexicon'

export interface Hit {
  /** 命中的原文片段，含前后文便于定位 */
  context: string
  /** 在全文中的字符下标 */
  pos: number
}

export interface Measurement {
  id: string
  label: string
  count: number
  /** 每千字密度，密度类指标才有 */
  perK?: number
  /** 常见区间，供审稿员参考，不是判决线 */
  reference?: string
  /** 测量口径说明，避免审稿员误读 */
  scope?: string
  hits: Hit[]
}

export interface TextMetrics {
  wordCount: number
  targetWords?: number
  /** 相对目标字数的偏离，如 +1.5 表示超出 150% */
  lengthDeviation?: number

  paragraphs: number
  sentences: number
  avgSentenceLen: number
  /** ≤12 字的句子占比 */
  shortSentenceRatio: number
  /** 段落长度变异系数，越小说明段落长度越均匀 */
  paragraphCV: number

  narrationWords: number
  dialogueWords: number

  /** 末尾三句原文，供审稿员判断收尾效果 */
  tailText: string
  /** 最后一个悬念信号距结尾几句；-1 表示全章未出现 */
  lastHookDistance: number

  measurements: Measurement[]
}

// ---------- 基础切分 ----------

/** 不含空白的字数，与项目既有口径一致 */
export function countWords(text: string): number {
  return text.replace(/\s/g, '').length
}

export function splitParagraphs(text: string): string[] {
  return text.split(/\n+/).map((p) => p.trim()).filter((p) => p.length > 0)
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\n+/g, '')
    .split(/(?<=[。！？…])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/**
 * 剥掉引号内的对话，只留叙述语。
 *
 * 角色是工程师、军人、AI 时，对话里出现大量精确参数属于人物塑造；
 * 同样的密度出现在叙述语里才值得怀疑。不区分会造成大量误报。
 */
export function stripDialogue(text: string): string {
  return text.replace(/[“"「『][^”"」』]*[”"」』]/g, '')
}

export function extractDialogue(text: string): string {
  return [...text.matchAll(/[“"「『]([^”"」』]*)[”"」』]/g)].map((m) => m[1]).join('')
}

// ---------- 命中工具 ----------

function contextOf(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - 10)
  const end = Math.min(text.length, idx + len + 10)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\n/g, ' ') + (end < text.length ? '…' : '')
}

function findLiteral(text: string, words: string[]): Hit[] {
  const hits: Hit[] = []
  for (const w of words) {
    let idx = text.indexOf(w)
    while (idx !== -1) {
      hits.push({ context: contextOf(text, idx, w.length), pos: idx })
      idx = text.indexOf(w, idx + w.length)
    }
  }
  return hits.sort((a, b) => a.pos - b.pos)
}

function findRegex(text: string, patterns: RegExp[]): Hit[] {
  const hits: Hit[] = []
  for (const p of patterns) {
    const flags = p.flags.includes('g') ? p.flags : p.flags + 'g'
    for (const m of text.matchAll(new RegExp(p.source, flags))) {
      hits.push({ context: contextOf(text, m.index ?? 0, m[0].length), pos: m.index ?? 0 })
    }
  }
  return hits.sort((a, b) => a.pos - b.pos)
}

function perThousand(count: number, wordCount: number): number {
  return wordCount === 0 ? 0 : +(count / (wordCount / 1000)).toFixed(1)
}

const NUMERIC_PATTERNS = [
  /百分之[零一二三四五六七八九十百]+/g,
  /零点[零一二三四五六七八九]+/g,
  /\d+(?:\.\d+)?%?/g,
  /[A-Z]-?\d+(?![\u4e00-\u9fff])/g,
  /[零一二三四五六七八九十百千万亿]{3,}(?=[个艘架条次秒分钟小时天年米光年度倍])/g,
]

const HOOK_SIGNALS = [
  /[？?]/,
  /(突然|忽然|竟然|居然|却是|原来|没想到)/,
  /(是谁|什么人|怎么可能|不可能|怎么会)/,
  /(活着|死了|背叛|真相|秘密|消失|出现|上了船)/,
]

/**
 * 找出重复出现的长片段。
 * 只报事实——审稿员来判断这是首尾呼应的手艺，还是词穷复读。
 */
function findRepeatedPhrases(text: string, minLen = 8): Measurement {
  const clean = text.replace(/\s/g, '')
  const seen = new Map<string, number[]>()
  for (let i = 0; i + minLen <= clean.length; i++) {
    const frag = clean.slice(i, i + minLen)
    if (!/^[\u4e00-\u9fff]+$/.test(frag)) continue
    const arr = seen.get(frag) || []
    arr.push(i)
    seen.set(frag, arr)
  }

  // 把重复的滑动窗口向右延伸成完整短语，否则同一句话会被拆成一串 8 字片段
  const extended = new Map<string, number[]>()
  for (const [, positions] of seen) {
    if (positions.length < 2) continue
    if (positions[positions.length - 1] - positions[0] <= minLen) continue
    let len = minLen
    while (positions[0] + len < clean.length) {
      const candidate = clean.slice(positions[0], positions[0] + len + 1)
      if (!positions.every((p) => clean.slice(p, p + len + 1) === candidate)) break
      len++
    }
    const full = clean.slice(positions[0], positions[0] + len)
    if (!extended.has(full)) extended.set(full, positions)
  }

  // 丢掉被更长短语包含的片段
  const kept: { frag: string; positions: number[] }[] = []
  for (const [frag, positions] of [...extended.entries()].sort((a, b) => b[0].length - a[0].length)) {
    if (kept.some((k) => k.frag.includes(frag))) continue
    kept.push({ frag, positions })
  }

  return {
    id: 'repeated-phrase',
    label: '重复出现的长片段',
    count: kept.length,
    scope: '≥8 字的纯中文片段在全章出现两次以上。可能是刻意呼应，也可能是复读，需人工判断。',
    hits: kept.slice(0, 8).map((k) => ({
      context: `「${k.frag}」出现 ${k.positions.length} 次`,
      pos: k.positions[0],
    })),
  }
}

// ---------- 主入口 ----------

export function measureText(text: string, opts: { targetWords?: number } = {}): TextMetrics {
  const wordCount = countWords(text)
  const paragraphs = splitParagraphs(text)
  const sentences = splitSentences(text)
  const narration = stripDialogue(text)
  const dialogue = extractDialogue(text)
  const narrationWords = countWords(narration)
  const dialogueWords = countWords(dialogue)

  // 段落长度分布
  const lens = paragraphs.map((p) => countWords(p))
  const mean = lens.length ? lens.reduce((a, b) => a + b, 0) / lens.length : 0
  const variance = lens.length ? lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length : 0
  const paragraphCV = mean === 0 ? 0 : +(Math.sqrt(variance) / mean).toFixed(2)

  // 句长分布
  const shortCount = sentences.filter((s) => countWords(s) <= 12).length
  const shortSentenceRatio = sentences.length ? +(shortCount / sentences.length).toFixed(2) : 0
  const totalSentenceLen = sentences.reduce((a, s) => a + countWords(s), 0)
  const avgSentenceLen = sentences.length ? Math.round(totalSentenceLen / sentences.length) : 0

  // 收尾：报原文和悬念信号位置，不下「有没有钩子」的结论
  const tailText = sentences.slice(-3).join('')
  let lastHookDistance = -1
  for (let i = sentences.length - 1; i >= 0 && i >= sentences.length - 15; i--) {
    if (HOOK_SIGNALS.some((r) => r.test(sentences[i]))) {
      lastHookDistance = sentences.length - 1 - i
      break
    }
  }

  const narrationNumeric = findRegex(narration, NUMERIC_PATTERNS)
  const dialogueNumeric = findRegex(dialogue, NUMERIC_PATTERNS)
  const similes = findRegex(text, SIMILE_TEMPLATES)
  const cliches = findLiteral(text, ALL_CLICHES)
  const hedges = findLiteral(narration, HEDGE_WORDS)
  const emotions = findRegex(text, EMOTION_TELLING)
  const explains = findRegex(text, EXPLAIN_TAIL)

  const measurements: Measurement[] = [
    {
      id: 'numeric-narration',
      label: '叙述语中的精确数字',
      count: narrationNumeric.length,
      perK: perThousand(narrationNumeric.length, narrationWords),
      reference: '每千字 ≤6 属常见范围',
      scope: '只统计叙述语，不含对话。对话里的参数通常属于人物设定。',
      hits: narrationNumeric.slice(0, 8),
    },
    {
      id: 'numeric-dialogue',
      label: '对话中的精确数字',
      count: dialogueNumeric.length,
      perK: perThousand(dialogueNumeric.length, dialogueWords),
      scope: '仅供参照：技术型角色说话带参数多为人物塑造，不必然是问题。',
      hits: dialogueNumeric.slice(0, 5),
    },
    {
      id: 'simile-template',
      label: '模板化明喻（像某种…／像是在…）',
      count: similes.length,
      perK: perThousand(similes.length, wordCount),
      reference: '整章 ≤2 处属常见范围',
      hits: similes.slice(0, 8),
    },
    {
      id: 'cliche',
      label: '套路化表达命中',
      count: cliches.length,
      perK: perThousand(cliches.length, wordCount),
      scope: '命中预设词表（神态、氛围、过渡三类），词表可能有遗漏也可能误伤。',
      hits: cliches.slice(0, 8),
    },
    {
      id: 'hedge',
      label: '模糊限定词（似乎／仿佛／微微／一丝）',
      count: hedges.length,
      perK: perThousand(hedges.length, narrationWords),
      reference: '叙述语每千字 ≤5 属常见范围',
      scope: '只统计叙述语。',
      hits: hedges.slice(0, 8),
    },
    {
      id: 'emotion-telling',
      label: '直接点名情绪',
      count: emotions.length,
      reference: '整章 ≤1 处属常见范围',
      hits: emotions.slice(0, 8),
    },
    {
      id: 'explain-tail',
      label: '动作后补充解释',
      count: explains.length,
      reference: '整章 ≤1 处属常见范围',
      hits: explains.slice(0, 8),
    },
    findRepeatedPhrases(text),
  ]

  return {
    wordCount,
    targetWords: opts.targetWords,
    lengthDeviation: opts.targetWords
      ? +((wordCount - opts.targetWords) / opts.targetWords).toFixed(2)
      : undefined,
    paragraphs: paragraphs.length,
    sentences: sentences.length,
    avgSentenceLen,
    shortSentenceRatio,
    paragraphCV,
    narrationWords,
    dialogueWords,
    tailText,
    lastHookDistance,
    measurements,
  }
}

/**
 * 把测量结果渲染成审稿 prompt 里的数据块。
 * 措辞刻意保持中立，避免诱导审稿员照单全收。
 */
export function metricsToPromptBlock(m: TextMetrics): string {
  const lines: string[] = []

  lines.push('【客观测量数据】以下为脚本统计结果，仅供参考，不构成判断。请结合作品设定与本章意图自行取舍。')
  lines.push('')
  lines.push(`篇幅：${m.wordCount} 字` +
    (m.targetWords ? `（目标 ${m.targetWords} 字，偏离 ${m.lengthDeviation! > 0 ? '+' : ''}${(m.lengthDeviation! * 100).toFixed(0)}%）` : ''))
  lines.push(`结构：${m.paragraphs} 段 / ${m.sentences} 句，平均句长 ${m.avgSentenceLen} 字，` +
    `短句(≤12字)占比 ${(m.shortSentenceRatio * 100).toFixed(0)}%，段落长度变异系数 ${m.paragraphCV}`)
  lines.push(`叙述与对话：叙述 ${m.narrationWords} 字 / 对话 ${m.dialogueWords} 字`)
  lines.push(`收尾：末尾三句为「${m.tailText}」；` +
    (m.lastHookDistance < 0
      ? '末 15 句内未检出悬念信号词。'
      : `最后一处悬念信号出现在倒数第 ${m.lastHookDistance + 1} 句。`))
  lines.push('')

  for (const meas of m.measurements) {
    if (meas.count === 0) continue
    const density = meas.perK !== undefined ? `，每千字 ${meas.perK}` : ''
    const ref = meas.reference ? `（${meas.reference}）` : ''
    lines.push(`· ${meas.label}：${meas.count} 处${density}${ref}`)
    if (meas.scope) lines.push(`  口径：${meas.scope}`)
    for (const h of meas.hits.slice(0, 5)) lines.push(`    - ${h.context}`)
  }

  return lines.join('\n')
}
