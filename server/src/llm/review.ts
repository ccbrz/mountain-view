/** Style-aware, evidence-backed chapter diagnosis for the writing desk. */

import { getDB } from '../db'
import { WriterSettings } from './writer-state'
import { buildModelWriterContext, requireWriterBudget } from './writer-context'
import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import * as P from './prompts'
import { parseLooseJSON } from './json-repair'
import { scanAiPatterns, groupAiFindings, AiCheck } from '../quality/ai-patterns'
import { outlineBeats } from './writer-preparation'

export interface ReviewIssue {
  dimension: string
  severity: '必改' | '可改'
  problem: string
  quote: string
  suggestion: string
  layer?: '故事' | '用笔' | '表达'
  resolution?: 'local' | 'author_decision'
  evidence?: { source: string; quote: string }[]
}

/** 各维度得分，满分见 SCORE_MAX，与 WRITER_REVIEW_SYSTEM 里的评分规则一致 */
export interface ReviewScores {
  coverage: number
  prose: number
  consistency: number
  webnovel: number
}

export const SCORE_MAX: ReviewScores = { coverage: 40, prose: 25, consistency: 15, webnovel: 20 }

/** 定稿线：总分达标且台本情节点全部写到 */
const PASS_SCORE = 80

/** 一处凭空加戏扣的覆盖分 */
const ADDED_PLOT_PENALTY = 10

export type BeatStatus = '已写' | '弱化' | '漏写'

export interface ReviewBeat {
  point: number
  /** 台本原句，由程序填，不用模型复述 */
  text: string
  status: BeatStatus
  quote: string
}

export interface ReviewResult {
  summary: string
  /** 由程序根据总分和漏写判定，不采用模型自己给的结论，免得和分数打架 */
  verdict: 'pass' | 'revise'
  scores: ReviewScores
  total: number
  /** 台本逐条核对结果，coverage 由它算出 */
  beats: ReviewBeat[]
  /** 表达扫描线索，仅供定位，不扣分 */
  aiChecks: AiCheck[]
  issues: ReviewIssue[]
  /** 原始返回，解析失败时保留给前端兜底展示 */
  raw?: string
}

export interface ReviewInput {
  chapterNum: number
  content: string
  outline: string
  writer: { novel: any; settings: WriterSettings; title: string; author_note: string }
}

/** 审稿要的是稳定的判断，同一章重审分数不该大幅跳动 */
const REVIEW_TEMPERATURE = 0.2

/** 润色后的场景格式里，「不揭示：」行不是情节点 */
const HOLD_BACK = /^\s*不揭示[:：]/

function coverage(beats: ReviewBeat[], issues: ReviewIssue[]) {
  const written = beats.length
    ? beats.reduce((s, b) => s + (b.status === '已写' ? 1 : b.status === '弱化' ? 0.5 : 0), 0) / beats.length
    : 1
  return Math.max(
    0,
    Math.round(SCORE_MAX.coverage * written) -
      ADDED_PLOT_PENALTY * issues.filter(i => i.dimension === '凭空加戏').length,
  )
}

/** 模型偶尔在 JSON 外带说明文字或漏字段；解析失败不抛错，退化成原文展示。 */
export function parseReviewJSON(text: string, outlineBeats: string[] = [], aiChecks: AiCheck[] = []): ReviewResult {
  const obj: any = parseLooseJSON(text, '{')
  if (
    !obj ||
    typeof obj !== 'object' ||
    !Array.isArray(obj.beats) ||
    !Array.isArray(obj.issues) ||
    !obj.scores ||
    !['prose', 'consistency', 'webnovel'].every(k => Number.isFinite(obj.scores[k]))
  ) {
    return {
      summary: '审稿意见解析失败，以下为模型原始输出。',
      verdict: 'revise',
      scores: { coverage: 0, prose: 0, consistency: 0, webnovel: 0 },
      total: 0,
      beats: [],
      aiChecks,
      issues: [],
      raw: text,
    }
  }
  const issues: ReviewIssue[] = obj.issues.map((i: any) => ({
    dimension: String(i?.dimension || '其他'),
    severity: i?.severity === '必改' ? '必改' : '可改',
    problem: String(i?.problem || ''),
    quote: String(i?.quote || ''),
    suggestion: String(i?.suggestion || ''),
    layer: i?.layer === '用笔' || i?.layer === '表达' ? i.layer : '故事',
    resolution: i?.resolution === 'local' ? 'local' : 'author_decision',
    evidence: Array.isArray(i?.evidence)
      ? i.evidence
          .filter((e: any) => typeof e?.source === 'string' && typeof e?.quote === 'string')
          .map((e: any) => ({ source: e.source, quote: e.quote }))
      : [],
  }))
  // 按程序拆出的情节点对齐；模型漏报的条目按漏写算，免得少报反而得高分
  const reported = new Map<number, any>()
  for (const b of obj.beats) reported.set(Number(b?.point), b)
  const beats: ReviewBeat[] = outlineBeats.map((text, idx) => {
    const b = reported.get(idx + 1)
    const status: BeatStatus = b?.status === '已写' || b?.status === '弱化' ? b.status : '漏写'
    return { point: idx + 1, text, status, quote: String(b?.quote || '') }
  })
  const clamp = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)))
  const scores: ReviewScores = {
    coverage: coverage(beats, issues),
    prose: clamp(obj.scores.prose, SCORE_MAX.prose),
    consistency: clamp(obj.scores.consistency, SCORE_MAX.consistency),
    webnovel: clamp(obj.scores.webnovel, SCORE_MAX.webnovel),
  }
  const total = scores.coverage + scores.prose + scores.consistency + scores.webnovel
  return {
    summary: String(obj.summary || ''),
    verdict:
      total >= PASS_SCORE && !issues.some(i => i.severity === '必改') && beats.every(b => b.status === '已写')
        ? 'pass'
        : 'revise',
    scores,
    total,
    beats,
    aiChecks,
    issues,
  }
}

export async function reviewChapter(config: LLMConfig, input: ReviewInput, ctx: InvokeContext, retries = 3) {
  let aiChecks: AiCheck[] = [],
    scanWarning = ''
  try {
    aiChecks = groupAiFindings(scanAiPatterns(input.content)).map(c => ({ ...c, severity: 'advisory' as const }))
  } catch {
    scanWarning = '表达扫描暂不可用，本次由模型按作者文风诊断，不影响原稿。'
  }
  const beatsText = outlineBeats(input.outline)
  const holdBack = input.outline
    .split('\n')
    .filter(l => HOLD_BACK.test(l))
    .map(l => l.trim())
  const numbered =
    beatsText.map((b, i) => `${i + 1}. ${b}`).join('\n') +
    (holdBack.length ? `\n\n以下不是情节点，是本章不能写出的内容：\n${holdBack.join('\n')}` : '')
  const context = requireWriterBudget(
    await buildModelWriterContext(
      getDB(),
      input.writer.novel,
      {
        chapter_idx: input.chapterNum,
        title: input.writer.title,
        raw_script: numbered,
        content: input.content,
        author_note: input.writer.author_note,
        scan_hints: JSON.stringify(
          aiChecks.slice(0, 8).map(c => ({ label: c.label, excerpts: c.excerpts.slice(0, 2) })),
        ),
        settings: { ...input.writer.settings, max_output_tokens: config.max_tokens },
      },
      config,
      'review',
    ),
  )
  const text = await invokeWithRetry(
    { ...config, temperature: REVIEW_TEMPERATURE },
    context.system_prompt,
    context.user_prompt,
    retries,
    ctx,
  )
  const review = parseReviewJSON(text, beatsText, aiChecks)
  if (scanWarning) review.summary += '\n' + scanWarning
  if (!review.raw) {
    for (const issue of review.issues) {
      issue.evidence = issue.evidence?.filter(
        e =>
          e.quote.trim() &&
          context.blocks.some(
            b =>
              !/范文|扫描|审稿依据|修改要求/.test(b.label) &&
              (b.label === e.source || b.label.replace(/^Lorebook · /, '设定 · ') === e.source) &&
              b.text.includes(e.quote),
          ),
      )
      if (!issue.quote.trim() || !input.content.includes(issue.quote) || !issue.evidence?.length)
        issue.resolution = 'author_decision'
    }
    review.issues.sort(
      (a, b) => ['故事', '用笔', '表达'].indexOf(a.layer!) - ['故事', '用笔', '表达'].indexOf(b.layer!),
    )
    // A claimed covered beat without an actual prose quote is unverified, even with a high score.
    for (const beat of review.beats)
      if (beat.status === '已写' && (!beat.quote.trim() || !input.content.includes(beat.quote))) beat.status = '弱化'
    review.scores.coverage = coverage(review.beats, review.issues)
    review.total = Object.values(review.scores).reduce((sum, score) => sum + score, 0)
    if (review.beats.some(b => b.status !== '已写')) review.verdict = 'revise'
  }
  if (context.warnings.length) review.summary += '\n上下文提示：' + context.warnings.join('；')
  return { review, context }
}
