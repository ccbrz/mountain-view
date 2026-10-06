/**
 * 我们自己补的 AI 味规则，覆盖 oh-story 脚本按词表抓不到的「换个说法」写法。
 * 只查叙述：引号内的对话先抹掉，台词里的「你知道」「像你妈」不算。
 * 输出格式与 vendor 脚本一致，由 scanAiPatterns 合并。
 */

import type { AiFinding } from './ai-patterns'

/** 比喻超过这个数才报，与起草 prompt 里的上限一致 */
export const SIMILE_LIMIT = 3

const RULES: { type: string; message: string; re: RegExp }[] = [
  {
    type: 'physio-reaction',
    message: '表达情绪的生理反应（瞳孔、喉结、指节、呼吸、心跳、后颈发凉等），换说法也算。删掉，或改成推动剧情的动作和台词',
    re: /瞳孔[^，。！？]{0,4}(收缩|缩|放大|紧)|喉结[^，。！？]{0,4}(滚|动)|(指节|关节|骨节)[^。！？]{0,8}(发白|泛白)|心跳[^，。！？]{0,4}(漏|加速|加快|骤|停)|呼吸[^，。！？]{0,2}(一滞|一窒|停滞|急促|一紧)|屏住(了)?呼吸|倒吸(了)?一口(凉)?气|(后颈|脊背|后背|脊梁)[^，。！？]{0,6}(发凉|一凉|凉意|发麻)|(手心|掌心)[^，。！？]{0,4}(出汗|冒汗|沁)/g,
  },
  {
    type: 'feel-tell',
    message: '叙述里直接说感受或认知（他感到、他意识到、他终于明白）。改成动作、选择或后果',
    re: /感到|感觉到|意识到|(终于|忽然|突然)明白/g,
  },
  {
    type: 'explain-tail',
    message: '叙述替读者补解释（那是……、这意味着、……的特征）。删掉解释句，让细节自己说话',
    re: /[，。]那是[^。！？”]{2,40}|这(意味着|说明)|的特征[，。]/g,
  },
]

const SIMILE_RE = /(?<![好想图影画镜人])像(?!素)/g

/** 章末最后几段里出现这些就算抒情收尾：比喻、「某种」、慢镜头副词 */
const ENDING_PARAS = 2
const LYRIC_ENDING_RE = /(?<![好想图影画镜人])像(?!素)|仿佛|如同|宛如|犹如|某种|一点一点|渐渐|悄然|无声地|静静地/g

/** 引号内的对话替换成等长空白，位置不变 */
function maskDialogue(line: string): string {
  return line.replace(/“[^”]*”|「[^」]*」|"[^"]*"/g, (m) => ' '.repeat(m.length))
}

/** 取命中所在的整句，作为修订时可逐字匹配的原文 */
function sentenceAt(line: string, idx: number): string {
  const start = Math.max(line.lastIndexOf('。', idx - 1), line.lastIndexOf('！', idx - 1), line.lastIndexOf('？', idx - 1)) + 1
  const ends = ['。', '！', '？'].map((p) => line.indexOf(p, idx)).filter((i) => i >= 0)
  const end = ends.length ? Math.min(...ends) + 1 : line.length
  return line.slice(start, end).trim()
}

export function scanLocalPatterns(text: string): AiFinding[] {
  const findings: AiFinding[] = []
  const similes: AiFinding[] = []
  text.split('\n').forEach((line, i) => {
    const narration = maskDialogue(line)
    const hit = (type: string, message: string, index: number) =>
      ({ line: i + 1, column: index + 1, type, severity: 'advisory' as const, message, excerpt: sentenceAt(line, index) })
    for (const r of RULES) {
      for (const m of narration.matchAll(r.re)) {
        // 以标点开头的匹配（「。那是」）要落在标点之后，否则会取到上一句
        findings.push(hit(r.type, r.message, m.index! + (/^[，。]/.test(m[0]) ? 1 : 0)))
      }
    }
    for (const m of narration.matchAll(SIMILE_RE)) similes.push(hit('simile-count', '', m.index!))
  })
  if (similes.length > SIMILE_LIMIT) {
    const message = `叙述里的比喻和「像……」共 ${similes.length} 处，全章不超过 ${SIMILE_LIMIT} 处。只留最贴合角色视角的，其余改成直写`
    findings.push(...similes.map((s) => ({ ...s, message })))
  }
  // 章末抒情：只看最后两段正文（跳过 --- 之类的分隔行）
  const lines = text.split('\n')
  const tail = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.trim() && !/^[-*=\s]+$/.test(l)).slice(-ENDING_PARAS)
  for (const { l, i } of tail) {
    for (const m of maskDialogue(l).matchAll(LYRIC_ENDING_RE)) {
      findings.push({
        line: i + 1, column: m.index! + 1, type: 'lyric-ending', severity: 'blocking',
        message: '章末抒情：最后两段用了比喻、「某种」或慢镜头式描写。停在具体的动作、台词或新出现的事实上，删掉之后的景物和感受',
        excerpt: sentenceAt(l, m.index!),
      })
    }
  }
  // 同一句命中同一类多次（「那是……的特征」）只报一次
  const seen = new Set<string>()
  return findings.filter((f) => !seen.has(f.type + f.excerpt) && seen.add(f.type + f.excerpt))
}
