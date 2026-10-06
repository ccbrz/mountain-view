import { LLMConfig } from './config'
import { invokeWithRetry, InvokeContext } from './invoke'
import { parseLooseJSON } from './json-repair'

export interface ContinuityIssue { problem: string; quote: string; evidence: string }
export class ContinuityConflict extends Error {
  status = 422
  constructor(public issues: ContinuityIssue[]) {
    super('连续性检查未通过，未更新正文或记忆：' + issues.map(i => `${i.problem}（「${i.quote}」；依据「${i.evidence}」）`).join('；'))
  }
}

const FORMAT = `只输出 JSON：{"issues":[{"problem":"简洁说明确认的矛盾","candidate_id":"C12","evidence_id":"S3"}]}。
无错误时 issues 为 []。candidate_id 必须指向候选的 C 编号，evidence_id 指向依据 S 编号或候选 C 编号（自身矛盾）。
只返回输入中确实存在的编号，不抄写或改写引文，程序会按编号取得原文。每个问题只选最直接的一对证据，最多5项，同一原因合并。`

const KNOWLEDGE_RULE = `知情范围明确列出知道秘密的角色，未列出的角色不知道。读者知情不等于角色知情。
逐段检查对白、感知、回忆、内心思考是否用了未获知的秘密；本章明确有获知过程则允许。
角色出示自己持有的物品、说出自己知道的信息，就是向他人披露的过程，允许原先不知道的人在此刻获知；不能把“别人不知道”误判成“知情者不能展示”。知情名单已经包含的角色也不能被判成不知情。
同一段持续描写某角色看着、想问、回忆时，夹在里面的秘密片段仍属于该角色的意识，不能用“可能是全知旁白”豁免；明确切换叙述视角的全知旁白才允许。`

/** 原文按编号引用，由代码取证；避免模型复述引文时改词、漏行、拼接导致无法核验。 */
export async function checkContinuity(config: LLMConfig, source: string, candidate: string, ctx: InvokeContext, state = false): Promise<ContinuityIssue[]> {
  // 回忆核对先看原场景，避免最新快照中无绝对日期的旧条目盖过原文。
  const historyAt = state ? -1 : source.indexOf('=== 历史原文证据')
  const orderedSource = historyAt < 0 ? source : source.slice(historyAt) + '\n' + source.slice(0, historyAt)
  const sourceLines = orderedSource.split(/\n+/).map(s => s.trim()).filter(Boolean)
  const candidateLines = candidate.split(/\n+/).map(s => s.trim()).filter(Boolean)
  const sources = sourceLines.map((s, i) => `[S${i + 1}] ${s}`).join('\n')
  const candidates = candidateLines.map((s, i) => `[C${i + 1}] ${s}`).join('\n')
  const knowledge = state ? '' : sourceLines.flatMap((s, i) => s.includes('｜知情：') ? [`[S${i + 1}] ${s}`] : []).join('\n')
  const user = `依据（截止上一章的状态和历史原文，或记忆提取依据）：\n${sources}\n\n候选：\n${candidates}`
  const rules = state ? `候选是本章结束后的记忆，只检查以下硬错误：
- 物品不能以自身为持有人；持有人是保管责任人，临时放桌上只改变位置，不能建议将“桌上”填入持有人。
- knowledge 的主体是信息，值是知情者，不得把事件流水账填进知情者。其他字段也只填当前状态，不重复整行记录。
- 当前事实必须反映本章结果；历史必须标为过去，不能冒充仍有效。新旧同名物品的历史不能混淆。
- 逐条核对伏笔的原问题：全部解答应移除，部分解答只留下原问题未解部分。不能一边写明目的，一边又说同一动机不明；不能给已解决问题添加新疑问来逃避关闭。新疑问若正文确实抛出应另建。
- 读者已知但角色未知，仍可保留“何时向角色揭晓”的伏笔，不能要求直接关闭。
- 梗概和衔接不能编造未发生的事件；同义转述和压缩措辞允许，不要求逐字复述，不评价文风。`
    : `候选是正文，只检查有证据的硬性矛盾：
- 回忆过去的物品、数量、颜色、原话、用途必须优先逐条对照历史原文块，而非只看梗概。最新快照里的“前一日”“三天前”若没有绝对时间/来源章，不能用它重算更早事件的时间，更不能据此否定历史原文。
- ${KNOWLEDGE_RULE}
- 伤势、物品归属、新旧物品历史是否发生矛盾，正文是否自相矛盾。
正常新发展允许：人物返回现场、物品再次转移、出现普通新物品、台本安排的揭晓、使用另一把家门钥匙（不等于丢失的灯塔钥匙复活）。
“未交代来源”“未提及”“没有描写交接过程”都不是反证，不能凭信息缺失报告矛盾。`
  const bounded = { ...config, temperature: 0.1 }
  const [raw, roleRaw] = await Promise.all([
    invokeWithRetry(bounded, `你是小说连续性核验员。${rules}\n${FORMAT}`, user, 2, ctx),
    knowledge ? invokeWithRetry(bounded, `你是小说信息差检查员，只检查角色使用秘密的越界，不评价其他情节。${KNOWLEDGE_RULE}\n${FORMAT}`,
      `明确的角色知情边界：\n${knowledge}\n\n候选正文：\n${candidates}`, 2, { ...ctx, task: `${ctx.task}:knowledge` }) : Promise.resolve('{"issues":[]}'),
  ])
  const parse = (raw: string): any[] => {
    const result: any = parseLooseJSON(raw, '{')
    if (!Array.isArray(result?.issues)) throw new Error('连续性检查未返回有效结果，未提交修改')
    return result.issues
  }
  const resolve = (id: unknown): string | undefined => {
    if (typeof id !== 'string' || !/^[SC][1-9]\d*$/.test(id)) return undefined
    return (id[0] === 'S' ? sourceLines : candidateLines)[Number(id.slice(1)) - 1]
  }
  let issues = [...parse(raw), ...parse(roleRaw)]
  if (issues.length) {
    const pairs = issues.map(issue => ({ ...issue, candidate: resolve(issue.candidate_id), evidence: resolve(issue.evidence_id) }))
    // 正文复核突出直接证据；记忆复核仍需整章原文，才能确认新事实和新伏笔是否有来源。
    const cited = [...new Set(issues.map(issue => issue.evidence_id))].map(id => `[${id}] ${resolve(id) || '无效编号'}`).join('\n')
    const verified = await invokeWithRetry(bounded,
      `你是小说连续性复核员。逐项核对下方原文证据对，保留确证的矛盾，删除误报，不新增问题。
初审可能定位错段落，请根据问题在候选全文中重新寻找证据，不要仅因初审编号不对就放过全文中存在的错误。
只有指向同一实体、同一事件的两条断言不可能同时成立时，才确认矛盾；没有描述过不等于没有发生过。
如果候选明确回忆同一次过去事件，却更改原文中的物品、数量、颜色或用途，这是确证矛盾，不能解释成后来发生了正常变化。原文没有证明是不同事件时，不要虚构另一次事件来替候选开脱。
${rules}
${FORMAT}\n另输出 rejected 数组，逐条说明删除初审意见的理由。`, `待复核问题及其原文证据对：\n${JSON.stringify(pairs)}\n\n引用依据：\n${state ? sources : cited}\n\n完整候选（用于核实事件、视角和披露过程）：\n${candidates}`, 2, { ...ctx, task: `${ctx.task}:verify` })
    issues = parse(verified)
  }
  return issues.map(issue => {
    const quote = typeof issue?.candidate_id === 'string' && issue.candidate_id.startsWith('C') ? resolve(issue.candidate_id) : undefined
    const evidence = resolve(issue?.evidence_id)
    if (typeof issue?.problem !== 'string' || !issue.problem.trim() || !quote || !evidence) throw new Error('连续性检查引用了不存在的原文编号，未提交修改，请重试')
    return { problem: issue.problem, quote, evidence }
  })
}
