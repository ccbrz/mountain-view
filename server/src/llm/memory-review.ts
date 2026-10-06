import { applyDelta, emptyState, ProgressState } from './progress'

export function editableMemory(state: ProgressState, chapter: number) {
  return {
    summary: state.summaries.find(s => s.chapter === chapter)?.text || '',
    facts: state.facts, hooks: state.hooks, handoff: state.handoff,
  }
}

/** 人工可修正语义，但不能伪造历史快照、计数器或跳过结构校验。 */
export function reviewedProgress(previous: ProgressState | null, input: any, chapter: number): ProgressState {
  const prev = previous || emptyState()
  if (!input || typeof input.summary !== 'string' || !input.summary.trim() || input.summary.length > 2000) throw new Error('本章摘要必填，最多 2000 字')
  if (!Array.isArray(input.facts) || !Array.isArray(input.hooks) || input.facts.length > 1000 || input.hooks.length > 1000) throw new Error('事实和伏笔必须为列表，分别最多 1000 条')
  if (!input.handoff || ['scene','doing','pending','mood','lastLines'].some(k => typeof input.handoff[k] !== 'string' || input.handoff[k].length > 3000)) throw new Error('请填写有效的章节衔接内容，每项最多 3000 字')
  const ids = new Set<string>(), keys = new Set<string>()
  for (const f of input.facts) {
    if (!f || typeof f.subject !== 'string' || f.subject.length > 1000 || typeof f.predicate !== 'string' || typeof f.kind !== 'string' || typeof f.value !== 'string') throw new Error('事实字段格式错误')
    if (f.id && (typeof f.id !== 'string' || !/^F[1-9]\d*$/.test(f.id) || ids.has(f.id))) throw new Error('事实编号无效或重复')
    if (f.id) ids.add(f.id)
    const key = JSON.stringify([f.kind, f.subject.trim(), f.predicate.trim()])
    if (keys.has(key)) throw new Error(`同一主体的同一属性只能保留一条：${f.subject} / ${f.predicate}`)
    keys.add(key)
  }
  for (const h of input.hooks) {
    if (!h || typeof h.content !== 'string' || !h.content.trim() || h.content.length > 2000) throw new Error('伏笔问题必填，最多 2000 字')
    if (h.id && (typeof h.id !== 'string' || !/^H[1-9]\d*$/.test(h.id) || ids.has(h.id))) throw new Error('伏笔编号无效或重复')
    if (h.id) ids.add(h.id)
  }
  const sameFact = (f: any, old: any) => f.id === old.id && f.kind === old.kind && f.subject.trim() === old.subject && f.predicate.trim() === old.predicate
  const facts: any[] = prev.facts.filter(old => !input.facts.some((f: any) => sameFact(f, old))).map(f => ({ op: 'end', id: f.id }))
  for (const f of input.facts) {
    const old = prev.facts.find(old => sameFact(f, old))
    facts.push(old ? { op: 'set', id: old.id, value: f.value } : { op: 'set', kind: f.kind, subject: f.subject, predicate: f.predicate, value: f.value })
  }
  const hooks: any[] = prev.hooks.map(old => {
    const current = input.hooks.find((h: any) => h.id === old.id)
    return !current ? { op: 'resolve', id: old.id }
      : current.content.trim() === old.content ? { op: 'mention', id: old.id }
        : { op: 'advance', id: old.id, content: current.content }
  })
  for (const h of input.hooks) if (!prev.hooks.some(old => old.id === h.id)) hooks.push({ op: 'new', content: h.content })
  return applyDelta(prev, { summary: input.summary, facts, hooks, handoff: input.handoff }, chapter)
}
