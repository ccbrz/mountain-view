/**
 * 进度更新实测：只调模型、打印结果，不写 progress 文档和快照（LLM 调用日志照常记录）。
 * 用法：./node_modules/.bin/tsx src/quality/try-progress.ts [configName]
 *
 * 1) 离线：坏 delta 必须被整体拒绝；同主体同属性自动取代
 * 2) 真模型连跑三章：第 1 章用真实正文，第 2、3 章是手写的短正文，专门埋了这些检查点——
 *    第 2 章：打开储物柜（揭晓）、老赵又提「那句话」但没说（只算提起）、苏晴承认看到签名（信息差更新）、林远舟换位置
 *    第 3 章：老赵说出那句话（揭晓）、苏晴承认 MI-7 身份但目的未知（推进不揭晓）、改造图芯片不见了（持有物变化）、抱着日志去驾驶舱（日志位置要跟着变）
 */
import fs from 'fs'
import path from 'path'
import { getLLMConfigByName } from '../llm/config'
import { updateProgress, applyDelta, renderProgress, ProgressState, RECENT_SUMMARIES } from '../llm/progress'

const config = getLLMConfigByName(process.argv[2] || 'ds-v4-flash')
if (!config) throw new Error('config not found')

const ch1 = fs.readFileSync(process.argv[3] || path.resolve(__dirname, '../../../demo-output/ch1-11-篇幅进SP起草.md'), 'utf-8')

const ch2 = `艾拉的投影熄灭之后，林远舟在折叠床上坐了很久，终于起身拉开了储物柜。

那块硬东西是一本纸质日志，封皮磨得发白，扉页写着「林星河 · 北斗勘探」。他翻了几页，全是手绘的星图和一串串数字，最后一页被撕掉了，只留下一道毛边。

舱门滑开，苏晴站在门口。林远舟把日志塞回柜子，顺手把数据板揣进外套内袋。

「你父亲的签名，我在酒吧就看到了。」苏晴说，「林星河。我找他找了三年。」

「你到底是谁？」

她没回答，转身走了。

林远舟去了驾驶舱。老赵盯着导航屏，头也没回：「她找你了？」

「她知道我爸的名字。」

老赵沉默了一会儿：「你爸上船那天跟我说过一句话，跟你今天说的一模一样。」

「什么话？」

「等到了地方再说。」老赵把自动驾驶又往前推了一档。

林远舟在副驾驶座上坐下，窗外的星云边缘开始泛出一层铁锈色的光。`

const ch3 = `北斗号在静默深渊外围停了下来。重力异常环就在前方三个天文单位，导航屏上的读数一直在跳。

老赵点了根烟，没抽，就那么夹着：「你爸那句话是——『如果我没回来，别让远舟来找我』。」

林远舟没说话。

中段舱室的门开了，苏晴走出来，把那台 MI-7 通讯器放在控制台上：「我是联邦军事情报局的人，这个你们早就查到了。」她看了一眼艾拉的终端，「但我为什么找林星河，现在不能说。」

老赵的手从武器面板上挪开了。

林远舟回生活舱拿日志，打开储物柜，日志还在，可他外套口袋里的改造图芯片不见了。他翻遍了口袋和床铺，什么也没找到。

他抱着日志回到驾驶舱，三个人谁也没开口。导航屏上，重力异常环的读数又跳了一下。`

function offlineChecks() {
  const base: ProgressState = {
    chapter: 5,
    summaries: [1, 2, 3, 4, 5].map((n) => ({ chapter: n, text: `第${n}章梗概` })),
    facts: [{ id: 'F1', kind: 'situation', subject: '林远舟', predicate: '位置', value: '生活舱' }],
    hooks: [{ id: 'H1', content: '储物柜里的东西', planted: 1, lastAdvanced: null, status: 'open' }],
    handoff: { scene: '生活舱', doing: '', pending: '', mood: '', lastLines: '' },
    nextFact: 2, nextHook: 2,
  }
  const handoff = { scene: '驾驶舱' }
  const ok = (cond: boolean, name: string, detail = '') => console.log(`${cond ? '✓' : '✗'} ${name}${detail ? `：${detail}` : ''}`)
  const expectFail = (name: string, delta: any, chapter = 6) => {
    try {
      applyDelta(base, delta, chapter)
      ok(false, name, '应该被拒绝却通过了')
    } catch (e: any) {
      ok(true, name, e.message)
    }
  }
  expectFail('引用不存在的事实', { summary: 's', handoff, facts: [{ op: 'end', id: 'F9' }] })
  expectFail('引用不存在的伏笔', { summary: 's', handoff, hooks: [{ op: 'advance', id: 'H9' }] })
  expectFail('作废不写理由', { summary: 's', handoff, hooks: [{ op: 'drop', id: 'H1' }] })
  expectFail('同一编号引用两次', { summary: 's', handoff, hooks: [{ op: 'resolve', id: 'H1' }, { op: 'advance', id: 'H1' }] })
  expectFail('缺 summary', { handoff })
  expectFail('章节号倒退', { summary: 's', handoff }, 5)
  expectFail('一处错整体拒绝', { summary: 's', handoff, facts: [{ op: 'set', kind: 'item', subject: '日志', predicate: '持有人', value: '林远舟' }, { op: 'end', id: 'F9' }] })

  const s = applyDelta(base, {
    summary: 's', handoff,
    facts: [{ op: 'set', kind: 'situation', subject: '林远舟', predicate: '位置', value: '驾驶舱' }],
    hooks: [{ op: 'mention', id: 'H1' }],
  }, 6)
  ok(s.facts.length === 1 && s.facts[0].value === '驾驶舱', '不带 id 的同主体同属性直接取代，旧值不留')
  ok(s.hooks[0].lastAdvanced === null && s.hooks[0].status === 'open', 'mention 不算推进')
  ok(base.facts[0].value === '生活舱', '入参未被修改')

  const r = applyDelta(base, { summary: 's', handoff, facts: [{ op: 'end', id: 'F1' }], hooks: [{ op: 'resolve', id: 'H1' }] }, 6)
  ok(r.facts.length === 0 && r.hooks.length === 0, 'end / resolve 后条目从状态里移除')

  const recent = renderProgress(base, 3)
  ok(recent.includes('第3章梗概') && !recent.includes('第2章梗概') && renderProgress(base).includes('第1章梗概'), '起草只带最近 3 章梗概，页面带全部')
}

async function main() {
  console.log('===== 离线校验 =====')
  offlineChecks()

  let state: ProgressState | null = null
  for (const [num, text] of [[1, ch1], [2, ch2], [3, ch3]] as const) {
    state = await updateProgress(config!, state, num, text, { novel_id: 1, task: `try-progress:${num}` })
    console.log(`\n===== 第 ${num} 章定稿后 =====\n${renderProgress(state)}`)
    console.log(`（状态 ${state.facts.length} 条事实、${state.hooks.length} 条伏笔）`)
  }
  console.log(`\nJSON 大小：${JSON.stringify(state).length} 字符；起草用文本：${renderProgress(state!, RECENT_SUMMARIES).length} 字符`)
}

main()
