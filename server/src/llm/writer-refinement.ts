/** One bounded refinement round. All results are derived candidates; no manuscript/Memory writes. */
import { getDB } from '../db'
import { buildModelWriterContext, requireWriterBudget, WriterInput } from './writer-context'
import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import { parseLooseJSON } from './json-repair'
import { applyPatches, Patch, ReviseResult } from './revise'
import type { ReviewIssue } from './review'

export const localIssues = (issues: ReviewIssue[], content: string) => issues.filter(i => i.resolution === 'local' && i.evidence?.length && i.quote.trim() && content.includes(i.quote) && i.suggestion.trim()).slice(0, 6)
export const issueNote = (i: ReviewIssue) => `【${i.layer || i.dimension} · ${i.dimension}】${i.problem}\n原文：${i.quote}\n依据：${JSON.stringify(i.evidence || [])}\n改法：${i.suggestion}`
export const proseChars = (text: string) => Array.from(text.replace(/\s/gu, '')).length

interface AuditItem { index: number; status: 'safe' | 'reject' | 'author_decision'; reason: string; evidence: {source: string; quote: string}[] }
export interface RefinementAudit { decisions: AuditItem[]; warning?: string }

export function parseRefinementAudit(raw: string, count: number, blocks: {label: string; text: string}[]): RefinementAudit {
  const obj: any = parseLooseJSON(raw, '{')
  if (!Array.isArray(obj?.patches) || obj.patches.length !== count || new Set(obj.patches.map((p: any) => p?.index)).size !== count || obj.patches.some((p: any) => !Number.isInteger(p?.index) || p.index < 1 || p.index > count)) {
    return {decisions: Array.from({length: count}, (_, i) => ({index: i + 1, status: 'reject', reason: '候选核验未完整返回，未放行此修改。', evidence: []})), warning: '候选核验格式不完整，所有候选均已保留在建议中，原稿未改变。'}
  }
  return {decisions: obj.patches.map((p: any) => {
    const evidence = Array.isArray(p.evidence) ? p.evidence.filter((e: any) => typeof e?.quote === 'string' && e.quote.trim() && blocks.some(b => (b.label === e.source || b.label.replace(/^Lorebook · /, '设定 · ') === e.source) && b.text.includes(e.quote))).map((e: any) => ({source: e.source, quote: e.quote})) : []
    const reason = typeof p.reason === 'string' ? p.reason.trim() : ''
    const status = p.status === 'safe' && evidence.length && reason ? 'safe' : p.status === 'author_decision' ? 'author_decision' : 'reject'
    return {index: p.index, status, reason: reason || '缺少可核对的判断依据，未放行。', evidence}
  })}
}

export async function auditRefinement(config: LLMConfig, novel: any, input: WriterInput, revised: ReviseResult, supported: ReviewIssue[], ctx: InvokeContext) {
  // Require every edit to be located in the original, tied to a selected issue, and independent of prior edits.
  const eligible: Patch[] = [], blocked: {patch: Patch; reason: string}[] = []
  for (const patch of revised.applied) {
    const start = input.content.indexOf(patch.find), end = start + patch.find.length
    const related = supported.some(i => {
      const at = input.content.indexOf(i.quote)
      return at < end && at + i.quote.length > start
    })
    if (start < 0 || input.content.indexOf(patch.find, start + 1) >= 0 || !related || eligible.some(p => {
      const at = input.content.indexOf(p.find)
      return start < at + p.find.length && end > at
    })) blocked.push({patch, reason: '补丁未独立定位到原稿中的可修问题，或与其他修改重叠。'})
    else eligible.push(patch)
  }
  let audit: RefinementAudit = {decisions: []}, context: ReviseResult['context']
  if (eligible.length) {
    context = requireWriterBudget(await buildModelWriterContext(getDB(), novel, {...input,
      instruction: JSON.stringify({issues: supported, patches: eligible.map((p, i) => ({index: i + 1, ...p}))}),
    }, config, 'audit'))
    // Quotes from instructions or the candidate itself are not independent source evidence.
    const sources = context.blocks.filter(b => !/修改要求|范文|扫描|审稿依据/.test(b.label))
    try {
      const raw = await invokeWithRetry({...config, temperature: .1}, context.system_prompt, context.user_prompt, 1, ctx)
      audit = parseRefinementAudit(raw, eligible.length, sources)
    } catch {
      audit = {decisions: eligible.map((_, i) => ({index: i + 1, status: 'reject', reason: '候选核验调用失败，未放行此修改。', evidence: []})), warning: '候选核验未完成，原稿保留。可稍后重新精修。'}
    }
    for (const decision of audit.decisions) if (decision.status !== 'safe') blocked.push({patch: eligible[decision.index - 1], reason: decision.reason})
  }
  const safe = eligible.filter((_, i) => audit.decisions.some(d => d.index === i + 1 && d.status === 'safe'))
  return {...applyPatches(input.content, safe), failed: revised.failed, blocked, audit, audit_context: context, context: context || revised.context}
}
