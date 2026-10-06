/**
 * 审稿员 Agent。分工：
 * - AI 味（文笔分）交给 oh-story 的检测脚本，确定性，程序算分；
 * - 模型只判台本覆盖、凭空加戏、设定一致性、网文指标。
 * 总分和定稿结论由程序计算。
 */

import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import * as P from './prompts'
import { parseLooseJSON } from './json-repair'
import { scanAiPatterns, groupAiFindings, AiCheck } from '../quality/ai-patterns'

export interface ReviewIssue {
  /** 台本漏写 / 凭空加戏 / 设定一致性 / 网文指标；AI味 由检测脚本结果合成 */
  dimension: string
  severity: '必改' | '可改'
  problem: string
  quote: string
  suggestion: string
}

/** 各维度得分，满分见 SCORE_MAX，与 SYSTEM_REVIEW 里的评分规则一致 */
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

/** 文笔分按命中类型扣，同类多处只扣一次 */
const BLOCKING_TYPE_PENALTY = 5
const ADVISORY_TYPE_PENALTY = 2

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
  /** AI 味检测结果，prose 由它算出 */
  aiChecks: AiCheck[]
  issues: ReviewIssue[]
  /** 原始返回，解析失败时保留给前端兜底展示 */
  raw?: string
}

export interface ReviewInput {
  chapterNum: number
  content: string
  outline: string
  worldSetting: string
  characters: string
  previousSummary: string
}

/** 审稿要的是稳定的判断，同一章重审分数不该大幅跳动 */
const REVIEW_TEMPERATURE = 0.2

/** 润色后的场景格式里，「【场景一】」标题、单独的「发生：」标签行和「不揭示：」行不是情节点 */
const SCENE_HEAD = /^\s*(?:【场景[^】]*】|发生[:：]\s*$)/
const HOLD_BACK = /^\s*不揭示[:：]/

/** 台本按行拆成情节点；只有一行时按句拆。去掉作者自己写的序号 */
export function splitOutlineBeats(outline: string): string[] {
  const clean = (s: string) => s.replace(/^\s*(?:\d+[.、)）]|[-*•])\s*/, '').trim()
  let beats = outline.split('\n').filter((l) => !SCENE_HEAD.test(l) && !HOLD_BACK.test(l)).map(clean).filter(Boolean)
  if (beats.length === 1) beats = beats[0].split(/(?<=[。！？!?])/).map(clean).filter(Boolean)
  return beats
}

/**
 * 模型偶尔会在 JSON 外面带点说明文字，兜底抠出最外层花括号再解析。
 * 解析失败不抛错——审稿意见是给人看的，退化成纯文本展示也比整个流程失败强。
 */
/** 检测结果合成一条意见，走现有的勾选→补丁修订流程 */
function aiChecksToIssue(checks: AiCheck[]): ReviewIssue {
  return {
    dimension: 'AI味',
    severity: '可改',
    problem: `检测脚本命中 ${checks.length} 类：${checks.map((c) => `${c.label}×${c.count}`).join('、')}`,
    quote: '',
    suggestion:
      '逐处改写，只改怎么说、不改说什么，不要换成新的套话或比喻：\n' +
      checks.map((c) => `【${c.label}】${c.message}\n${c.excerpts.map((e) => `　「${e}」`).join('\n')}`).join('\n'),
  }
}

export function parseReviewJSON(text: string, outlineBeats: string[] = [], aiChecks: AiCheck[] = []): ReviewResult {
  const obj: any = parseLooseJSON(text, '{')

  if (obj && typeof obj === 'object') {
    const issues: ReviewIssue[] = Array.isArray(obj.issues)
      ? obj.issues.map((i: any) => ({
          dimension: String(i?.dimension || '其他'),
          severity: i?.severity === '必改' ? '必改' : '可改',
          problem: String(i?.problem || ''),
          quote: String(i?.quote || ''),
          suggestion: String(i?.suggestion || ''),
        }))
      : []
    if (aiChecks.length) issues.push(aiChecksToIssue(aiChecks))
    // 按程序拆出的情节点对齐；模型漏报的条目按漏写算，免得少报反而得高分
    const reported = new Map<number, any>()
    for (const b of Array.isArray(obj.beats) ? obj.beats : []) reported.set(Number(b?.point), b)
    const beats: ReviewBeat[] = outlineBeats.map((text, idx) => {
      const b = reported.get(idx + 1)
      const status: BeatStatus = b?.status === '已写' || b?.status === '弱化' ? b.status : '漏写'
      return { point: idx + 1, text, status, quote: String(b?.quote || '') }
    })
    const beatScore = beats.length
      ? beats.reduce((s, b) => s + (b.status === '已写' ? 1 : b.status === '弱化' ? 0.5 : 0), 0) / beats.length
      : 1
    const addedPlot = issues.filter((i) => i.dimension === '凭空加戏').length
    const clamp = (v: unknown, max: number) => Math.min(max, Math.max(0, Math.round(Number(v) || 0)))
    const scores: ReviewScores = {
      coverage: Math.max(0, Math.round(SCORE_MAX.coverage * beatScore) - ADDED_PLOT_PENALTY * addedPlot),
      prose: Math.max(
        0,
        SCORE_MAX.prose -
          aiChecks.reduce((s, c) => s + (c.severity === 'blocking' ? BLOCKING_TYPE_PENALTY : ADVISORY_TYPE_PENALTY), 0),
      ),
      consistency: clamp(obj.scores?.consistency, SCORE_MAX.consistency),
      webnovel: clamp(obj.scores?.webnovel, SCORE_MAX.webnovel),
    }
    const total = scores.coverage + scores.prose + scores.consistency + scores.webnovel
    const allWritten = beats.every((b) => b.status === '已写')
    return {
      summary: String(obj.summary || ''),
      verdict: total >= PASS_SCORE && !issues.some(i => i.severity === '必改') && allWritten ? 'pass' : 'revise',
      scores,
      total,
      beats,
      aiChecks,
      issues,
    }
  }

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

export async function reviewChapter(
  config: LLMConfig,
  input: ReviewInput,
  ctx: InvokeContext,
): Promise<{ review: ReviewResult }> {
  const aiChecks = groupAiFindings(scanAiPatterns(input.content))
  const outlineBeats = splitOutlineBeats(input.outline)
  const holdBack = input.outline.split('\n').filter((l) => HOLD_BACK.test(l)).map((l) => l.trim())

  const text = await invokeWithRetry(
    { ...config, temperature: REVIEW_TEMPERATURE },
    P.SYSTEM_REVIEW,
    P.USER_REVIEW({
      outline: outlineBeats.map((b, i) => `${i + 1}. ${b}`).join('\n') + (holdBack.length ? `\n\n以下不是情节点，是本章不能写出的内容：\n${holdBack.join('\n')}` : ''),
      content: input.content,
      worldSetting: input.worldSetting,
      characters: input.characters,
      previousSummary: input.previousSummary,
      chapterNum: input.chapterNum,
    }),
    3,
    ctx,
  )

  return { review: parseReviewJSON(text, outlineBeats, aiChecks) }
}
