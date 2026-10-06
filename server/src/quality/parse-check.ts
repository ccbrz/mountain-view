import { parseReviewJSON } from '../llm/review'

/**
 * 审稿结果解析的鲁棒性验证：模型返回格式不稳定是常态，
 * 这条链路挂了会让整章审稿白跑，所以单独验。
 * 用法：npx tsx src/quality/parse-check.ts
 */

const payload = {
  summary: '台本基本兑现，但有一处漏写和若干文笔问题。',
  issues: [
    {
      dimension: '台本漏写',
      severity: '必改',
      problem: '台本第4点「苏晴出手击退海盗」只写了结果，没有展开过程',
      quote: '海盗退了',
      suggestion: '补一段交火过程',
    },
    {
      dimension: '文笔质感',
      severity: '可改',
      problem: '公式化比喻过多',
      quote: '像某种大型生物的金属心跳',
      suggestion: '换成具体喻体或直接删掉',
    },
  ],
  scores: { coverage: 30, prose: 18, consistency: 15, webnovel: 16 },
}

const cases: [string, string][] = [
  ['裸 JSON', JSON.stringify(payload)],
  ['围栏包裹（走 cleanLLMOutput 后的形态）', JSON.stringify(payload, null, 2)],
  ['带前言的 JSON', '好的，以下是审稿意见：\n\n' + JSON.stringify(payload)],
  ['带前后文的 JSON', '审稿如下：\n' + JSON.stringify(payload) + '\n\n希望对你有帮助。'],
  // 实测遇到过的失效：模型在中文串里用了未转义的英文双引号
  ['字符串内未转义的英文引号', '{"summary":"老赵"起初拒绝"这一拍被压缩掉","issues":[],"scores":{"coverage":40,"prose":25,"consistency":15,"webnovel":20}}'],
  ['字段缺失', '{"summary":"还行"}'],
  ['完全不是 JSON', '抱歉，我无法完成这个请求。'],
]

let pass = 0
for (const [name, input] of cases) {
  const r = parseReviewJSON(input)
  const degraded = r.raw ? ' → 降级为原始输出' : ''
  console.log(
    `${name.padEnd(34)} verdict=${r.verdict.padEnd(6)} ` +
    `总分 ${String(r.total).padStart(3)} | issues ${r.issues.length}${degraded}`
  )
  if (r && Array.isArray(r.issues) && r.scores && typeof r.summary === 'string') pass++
}
console.log(`\n${pass}/${cases.length} 通过（要求：任何输入都不抛异常、结构完整）`)

// 未转义引号这一条必须真正解析出内容，而不是降级
const repaired = parseReviewJSON(cases[4][1])
console.log(
  repaired.raw
    ? '✗ 未转义引号的用例降级了，修复器没生效'
    : `✓ 未转义引号已修复，summary = ${repaired.summary}`
)
