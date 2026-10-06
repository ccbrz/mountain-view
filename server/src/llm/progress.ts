import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import { checkContinuity } from './continuity'
import * as P from './prompts'

/**
 * 故事进度 = 当前状态快照（事实 + 伏笔 + 下一章衔接）+ 每章梗概。
 * 模型每章只输出变化（delta JSON），代码校验后合并：模型漏写的条目是保留而不是丢失；
 * 过时的条目靠模型逐条核对后显式 end 掉，状态只留当前成立的东西。历史靠每章快照（doc-snapshots.ts）。
 */

export type FactKind = 'situation' | 'relation' | 'item' | 'knowledge'
export interface Fact { id: string; kind: FactKind; subject: string; predicate: string; value: string }

export type HookStatus = 'open' | 'progressing' | 'deferred'
export interface Hook { id: string; content: string; planted: number; lastAdvanced: number | null; status: HookStatus }

export interface Handoff { scene: string; doing: string; pending: string; mood: string; lastLines: string }

export interface ProgressState {
  /** 已并入的最后一章 */
  chapter: number
  /** 运行时只需最近几章；完整梗概按章存储，不嵌入状态快照。 */
  summaries: { chapter: number; text: string }[]
  facts: Fact[]
  hooks: Hook[]
  handoff: Handoff
  nextFact: number
  nextHook: number
}

const KINDS: Record<FactKind, string> = {
  situation: '角色当前处境',
  relation: '人物关系',
  item: '持有物',
  knowledge: '信息差',
}
const HOOK_STATUS: Record<HookStatus, string> = { open: '未推进', progressing: '推进中', deferred: '搁置' }

/** 起草、审稿只带最近几章梗概；更早的细节另从历史原文检索。 */
export const RECENT_SUMMARIES = 3

export const emptyState = (): ProgressState => ({
  chapter: 0, summaries: [], facts: [], hooks: [],
  handoff: { scene: '', doing: '', pending: '', mood: '', lastLines: '' },
  nextFact: 1, nextHook: 1,
})

// ---------- 渲染 ----------

/** withIds：给进度模型看时带编号，方便它引用；给写手、审稿、页面看时不带 */
export function renderState(s: ProgressState, withIds: boolean): string {
  const tag = (id: string) => (withIds ? `[${id}] ` : '')
  const actors = [...new Set(s.facts.filter(f => f.kind === 'situation').map(f => f.subject))]

  const factSections = (Object.keys(KINDS) as FactKind[]).map((kind) => {
    const facts = s.facts.filter((f) => f.kind === kind)
    // 同一主体的条目排在一起（按主体首次出现的顺序），否则更新过的条目会跑到末尾
    const subjects = [...new Set(facts.map((f) => f.subject))]
    const lines = subjects.flatMap((sub) => facts.filter((f) => f.subject === sub))
      .map((f) => {
        // 写手看到明确的负向边界，不能把“读者已知”误当成主角已知。
        // 仅渲染提示，不把派生的未知名单写回事实；最多列12人，避免长篇演员表反复膨胀。
        const unknown = !withIds && kind === 'knowledge' && !/所有|全体|众人|大家/.test(f.value)
          ? actors.filter(actor => !f.value.includes(actor) && !f.subject.includes(actor)).slice(0, 12) : []
        return `- ${tag(f.id)}${f.subject}｜${f.predicate}：${f.value}${unknown.length ? `；尚未获知：${unknown.join('、')}（除非本章明确写出获知过程）` : ''}`
      })
    return `## ${KINDS[kind]}\n${lines.join('\n') || '无'}`
  })

  const hooks = s.hooks.map((h) =>
    `- ${tag(h.id)}${h.content}｜第${h.planted}章埋下｜最近推进：${h.lastAdvanced ? `第${h.lastAdvanced}章` : '无'}｜状态：${HOOK_STATUS[h.status]}`)

  const ho = s.handoff
  const handoff = ho.scene
    ? [`结尾场面：${ho.scene}`, `正在做 / 刚决定：${ho.doing || '无'}`, `悬而未决：${ho.pending || '无'}`, `情绪：${ho.mood || '无'}`, `最后一段：${ho.lastLines || '无'}`]
      .map((l) => `- ${l}`).join('\n')
    : '无'

  return [...factSections, `## 伏笔\n${hooks.join('\n') || '无'}`, `## 下一章衔接\n${handoff}`].join('\n\n')
}

/** 进度文本。recent 给了就只带最近几章梗概（起草、审稿用），不给就全带（页面用） */
export function renderProgress(s: ProgressState, recent?: number): string {
  const list = recent ? s.summaries.slice(-recent) : s.summaries
  const summaries = list.map((c) => `### 第${c.chapter}章\n${c.text}`).join('\n\n')
  return `# ${recent ? '最近章节梗概' : '章节梗概'}\n${summaries || '无'}\n\n# 当前状态\n${renderState(s, false)}`
}

// ---------- 校验 + 合并 ----------

const str = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

class DeltaError extends Error {
  constructor(public problems: string[]) { super(problems.join('；')) }
}

function parseJson(raw: string): any {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) throw new DeltaError(['输出里没有 JSON 对象'])
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch (e: any) {
    throw new DeltaError([`JSON 解析失败：${e.message}`])
  }
}

/** 把一章的 delta 合并进状态，返回新状态（不改入参）。有任何问题整体拒绝，不做部分合并 */
export function applyDelta(prev: ProgressState, delta: any, chapter: number): ProgressState {
  if (chapter <= prev.chapter) throw new Error(`进度已到第 ${prev.chapter} 章，不能再并入第 ${chapter} 章`)
  const s: ProgressState = structuredClone(prev)
  const errs: string[] = []

  if (!str(delta?.summary)) errs.push('缺少 summary')
  const ho = delta?.handoff
  if (!str(ho?.scene)) errs.push('handoff.scene 不能为空')
  if (!Array.isArray(delta?.facts ?? [])) errs.push('facts 必须是数组')
  if (!Array.isArray(delta?.hooks ?? [])) errs.push('hooks 必须是数组')
  if (errs.length) throw new DeltaError(errs)

  // 引用的编号只认进入本章时就有的条目；同一条被引用两次也报错
  const known = { facts: new Set(prev.facts.map(f => f.id)), hooks: new Set(prev.hooks.map(h => h.id)) }
  const take = (id: unknown, at: string): boolean => {
    const ids = at.startsWith('facts') ? known.facts : known.hooks
    if (typeof id !== 'string' || !ids.has(id)) return errs.push(`${at}：找不到编号 ${String(id)}`), false
    ids.delete(id)
    return true
  }
  const removeFact = (id: string) => { s.facts = s.facts.filter((f) => f.id !== id) }

  ;(delta.facts ?? []).forEach((op: any, i: number) => {
    const at = `facts[${i}]`
    if (op?.op === 'end') {
      if (take(op.id, at)) removeFact(op.id)
      return
    }
    if (op?.op !== 'set') return errs.push(`${at}：op 只能是 set 或 end`)
    if (!str(op.value)) return errs.push(`${at}：缺少 value`)

    let base: Pick<Fact, 'kind' | 'subject' | 'predicate'>
    if (op.id !== undefined) {
      if (!take(op.id, at)) return
      base = prev.facts.find((f) => f.id === op.id)!
      removeFact(op.id)
    } else {
      if (!Object.hasOwn(KINDS, op.kind)) return errs.push(`${at}：kind 只能是 ${Object.keys(KINDS).join(' / ')}`)
      if (!str(op.subject) || !str(op.predicate)) return errs.push(`${at}：新增事实要有 subject 和 predicate`)
      base = { kind: op.kind, subject: op.subject.trim(), predicate: op.predicate.trim() }
      // 同主体同属性只保留一条：模型没带 id 也按新值取代
      s.facts = s.facts.filter((f) => !(f.kind === base.kind && f.subject === base.subject && f.predicate === base.predicate))
    }
    const predicates = { situation: ['位置', '身体状况', '当前目标'], relation: ['关系'], item: ['持有人', '位置', '状态'], knowledge: ['知情'] }
    if (!predicates[base.kind].includes(base.predicate)) return errs.push(`${at}：${base.kind} 的属性不允许使用 ${base.predicate}`)
    if (op.value.includes(`｜${base.predicate}`)) return errs.push(`${at}：value 只能写值，不要复制主体、属性或整行旧记录`)
    if (op.value.length > 300) return errs.push(`${at}：value 最多300字，只写当前状态，不要追加剧情经过`)
    if ((base.predicate === '持有人' || base.kind === 'knowledge') && base.subject === op.value.trim()) {
      return errs.push(`${at}：值不能重复主体；持有人应写人物，知情应写知情者`)
    }
    s.facts.push({ ...base, id: op.id || `F${s.nextFact++}`, value: op.value.trim() })
  })

  ;(delta.hooks ?? []).forEach((op: any, i: number) => {
    const at = `hooks[${i}]`
    if (op?.op === 'new') {
      if (!str(op.content)) return errs.push(`${at}：new 要有 content`)
      s.hooks.push({ id: `H${s.nextHook++}`, content: op.content.trim(), planted: chapter, lastAdvanced: null, status: 'open' })
      return
    }
    if (!['advance', 'mention', 'resolve', 'defer', 'drop'].includes(op?.op)) {
      return errs.push(`${at}：op 只能是 new / advance / mention / resolve / defer / drop`)
    }
    if (op.op === 'drop' && !str(op.reason)) return errs.push(`${at}：drop 必须写 reason`)
    if (!take(op.id, at)) return
    const h = s.hooks.find((x) => x.id === op.id)!
    switch (op.op) {
      case 'advance':
        if (!str(op.content)) errs.push(`${at}：advance 必须写更新后仍未解的问题 content，全部解决请 resolve`)
        if (str(op.content)) h.content = op.content.trim()
        h.lastAdvanced = chapter; h.status = 'progressing'; break
      case 'mention': break // 只是提起，不算推进
      case 'defer': h.status = 'deferred'; break
      case 'resolve': case 'drop': s.hooks = s.hooks.filter((x) => x.id !== op.id); break
    }
  })

  for (const id of known.hooks) errs.push(`hooks：必须核对已有伏笔 ${id}，未变用 mention，部分解决用 advance + content，全部解决用 resolve`)
  if (errs.length) throw new DeltaError(errs)

  s.chapter = chapter
  s.summaries = [...s.summaries.filter((c) => c.chapter < chapter), { chapter, text: delta.summary.trim() }]
  s.handoff = { scene: text(ho.scene), doing: text(ho.doing), pending: text(ho.pending), mood: text(ho.mood), lastLines: text(ho.lastLines) }
  return s
}

const MAX_ATTEMPTS = 3

/** existing 是进入本章时的进度快照（第一章为 null）；返回本章定稿后的进度 */
export async function updateProgress(
  config: LLMConfig,
  existing: ProgressState | null,
  chapterNum: number,
  chapterContent: string,
  ctx: InvokeContext,
  options: { audit?: boolean } = {},
): Promise<ProgressState> {
  const prev = existing ?? emptyState()
  const user = P.USER_PROGRESS_UPDATE(chapterNum, chapterContent, prev.chapter ? renderState(prev, true) : '')

  let feedback = ''
  for (let i = 1; ; i++) {
    const raw = await invokeWithRetry({ ...config, temperature: 0 }, P.SYSTEM_PROGRESS, user + feedback, 2, { ...ctx, task: i > 1 ? `${ctx.task}:retry${i - 1}` : ctx.task })
    try {
      const next = applyDelta(prev, parseJson(raw), chapterNum)
      if (options.audit === false) return next // 人工核对流程只整理候选记忆，由作者决定语义是否正确。
      const issues = await checkContinuity(config, user, `# 本章梗概\n${next.summaries.find(c => c.chapter === chapterNum)!.text}\n\n${renderState(next, true)}`, { ...ctx, task: `${ctx.task}:audit` }, true)
      if (issues.length) throw new DeltaError(issues.map(i => `${i.problem}；错误：${i.quote}；依据：${i.evidence}`))
      return next
    } catch (e) {
      if (!(e instanceof DeltaError) || i >= MAX_ATTEMPTS) throw e
      feedback = `\n\n上一次的完整 JSON：\n${raw}\n\n只修正下列问题，其余正确操作保留，不要重新发明一套变化；输出修正后的完整 JSON：\n${e.problems.map((p) => `- ${p}`).join('\n')}`
    }
  }
}
