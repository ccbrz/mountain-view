/** Read-only replay of the first-chapter request; writes comparison artifacts, never the manuscript. */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { countInputTokens, invokeLLMResult } from '../llm/adapter'

async function main() {
  const root = path.resolve(__dirname, '../../..')
  const db = new Database(path.join(root, 'data/app.db'), { readonly: true })
  const baseline: any = db.prepare('SELECT * FROM llm_call_logs WHERE id = ?').get('log_1_1793182487214')
  assert(baseline?.response, 'Baseline generation is missing')
  const artifact = (
    db.prepare('SELECT content FROM writer_artifacts WHERE novel_id = ?').all(baseline.novel_id) as any[]
  )
    .map(row => JSON.parse(row.content))
    .find(row => row.content === baseline.response)
  assert(artifact?.source?.settings, 'Matching request snapshot is missing')
  const settings = artifact.source.settings
  const config: any = db.prepare('SELECT * FROM llm_configs WHERE id = ?').get(artifact.context.model.id)
  assert(config?.model_name === baseline.model_name, 'Model changed')
  db.close()
  config.temperature = settings.temperature
  config.max_tokens = settings.max_output_tokens
  if (process.argv[2]) {
    // Keep repair isolated, including any lazily imported database helpers.
    process.env.DB_PATH = ':memory:'
    const { applyPatches } = await import('../llm/revise')
    const { parseLooseJSON } = await import('../llm/json-repair')
    const dir = path.resolve(process.argv[2])
    const draft = fs.readFileSync(path.join(dir, 'after.txt'), 'utf8')
    const instructions = `这是一次编辑修订，不是续写。仅输出 JSON 数组，每项为 {"note":"修改原因","find":"逐字引用且唯一的原文","replace":"替换后的正文"}。各项 find 不得重叠；未命中的正文保持原样。不要输出 Markdown 代码块。
下面的问题必须修正，同时通过展开指定事件，使修订后的完整章节接近 4000 字，建议 3800–4400 字。现稿 3045 字；删掉越界内容后，需要补写更多有效过程，不能只替换几句话。补写集中在交涉、遭袭和登船，不在结尾添加情节。
1. 开头删除凭空出现的老胡。老赵最初不知道林远舟的身份；先拒绝借船，听到明确的“林星河”名字后态度才改变，不可看一眼扳手便认出父子关系。展开至少两轮交涉：风险与费用、林远舟的应对、老赵仍有顾虑但最终答应。用动作与话语推动，别用泛泛的沉默代替。
2. 删除所有父亲预先留信、讯号、交代旧扳手接应的内容及由此产生的回忆和结论。老赵只知道既有旧交，不得创造父亲安排好此次旅程的事实。把“他没死”改为林远舟希望查明下落，避免宣告存亡。
3. 保留现有交战中的维修和规避，展开至少一次应对失败及其后果，使救援前有真实的困境。苏晴击中一艘后，交代另外两艘如何受到威胁而撤退，不能让它们凭空消失；不要发明全新武器或技术奇迹。
4. 苏晴的对外说法限于赏金猎人、需要搭船。删除她确知静默深渊目的地、认得秘密坐标、曾在勘探署和讨论林星河研究等新增信息。让老赵围绕燃料不足的说法、陌生人为何愿意帮忙、武器与活动范围继续试探，再有条件允许登船。让林远舟观察她的应答，不替她解释秘密。
5. 删除 normally、【 本章结束 】及独立的 --- 分隔行。把单向私有频道上的问答矛盾修为舰内私密通话。
6. 结尾止于艾拉报告联邦军方加密通讯器、林远舟产生怀疑；删除后续观景抒情、信标、钥匙、深渊给答案等总结。身份仍未确认，不出现第七处和清除知情人。
7. 不新增角色、家属、任务、重大往事或下一章事件。对话各有口吻，少用“像……”解释人物目光与语气。`
    const system =
      '你是小说编辑。严格按提供的台本和已确认设定执行定向补丁修订，扩写当前事件的具体过程，不增加新的剧情事实。'
    const user =
      fs.readFileSync(path.join(dir, 'user.txt'), 'utf8').split('【本次任务】')[0] +
      '\n\n【待修订正文】\n' +
      draft +
      '\n\n【本次修订要求】\n' +
      instructions
    fs.writeFileSync(path.join(dir, 'repair-request.txt'), system + '\n\n' + user)
    const inputTokens = await countInputTokens(config, system, user)
    assert(inputTokens !== undefined && inputTokens + config.max_tokens + 512 <= settings.context_tokens)
    console.log(JSON.stringify({ repair: dir, inputTokens, temperature: 0.3 }))
    const result = await invokeLLMResult({ ...config, temperature: 0.3 }, system, user)
    fs.writeFileSync(path.join(dir, 'repair-response.txt'), result.content)
    assert(result.finish_reason === 'stop', 'Repair response did not finish normally')
    const patches = parseLooseJSON<any[]>(result.content, '[')
    assert(
      Array.isArray(patches) &&
        patches.length > 0 &&
        patches.every(p => typeof p.find === 'string' && typeof p.replace === 'string'),
      'Invalid patch response',
    )
    const revised = applyPatches(draft, patches)
    fs.writeFileSync(path.join(dir, 'repair-result.json'), JSON.stringify(revised, null, 2))
    assert(revised.failed.length === 0, 'Unmatched patches: inspect repair-result.json; final draft not published')
    fs.writeFileSync(path.join(dir, 'revised.txt'), revised.content)
    console.log(
      JSON.stringify({
        applied: revised.applied.length,
        failed: revised.failed.length,
        chars: Array.from(revised.content.replace(/\s/gu, '')).length,
        finish_reason: result.finish_reason,
      }),
    )
    return
  }

  const style = `【本书文风指南】
- 第三人称限知，主要贴近林远舟；写他能观察、知道和合理推测的事。
- 冷静、克制的太空悬疑。技术细节服务于人物的处境和行动，不堆砌参数，不把每个人写成技术说明书。
- 重要场面用动作、对话和现场反应展开，让人物的顾虑和关系变化发生在读者眼前；过渡可以简略。
- 长短句和段落自然交替；情绪可以通过迟疑、反问、未说完的话呈现，不反复解释其含义。
- 老赵有现实顾虑，林远舟执拗而有分寸，苏晴的回答有所保留。人物各有口吻，避免同样的冷硬短句。`
  const system = baseline.system_prompt.replace(/【本书文风指南】[\s\S]*?(?=【篇幅要求】)/, style + '\n\n')
  assert(system !== baseline.system_prompt, 'Style replacement did not match')
  const guidance = `【本章展开要求】
目标约 4000 字，交付可直接阅读的完整章节，而不是剧情概述。完整保留下方台本的事件顺序与落点。
重点展开借船交涉、海盗袭击以及允许陌生人登船时的试探。每个重要转折要有可见的阻碍、人物的应对、对方的反应和局面变化；不要只写“犹豫几秒”“陷入危机”就跳到结果。
可以补足当前事件内的谈判往返、操船避险、维修动作和登船核验，让这些细节推动局面。不要为凑字数增加支线、背景灾难、家属、秘密安排或新技术设定。苏晴仍然从另一艘船出手解围，但在她到来前，要让北斗号的脱险尝试和困境充分成立。

【本章信息边界】
世界观和人物档案包含作者掌握的全书信息，不表示叙述者或人物在这一章可以全部披露。
老赵只在听到林星河名字后态度软化；用已有旧交和顾虑表现转变，不添加“父亲早就安排接应、留信预言儿子到来”等新事实。
苏晴对外自称赏金猎人。她的真实组织、具体任务、私下关注林远舟的经历均不在本章揭示，也不能用她的内心独白透露。
结尾艾拉只能报告扫描到了联邦军方的加密通讯器。不能进一步确认第七处、清除知情人的命令、具体任务或苏晴的真实身份。林远舟可以怀疑，但不能把怀疑写成结论。停在这个线索带来的不确定感，不写后续调查。
不得把林星河的失踪写成已确认死亡。`
  const user = baseline.user_prompt.replace('【本次任务】', guidance + '\n\n【本次任务】')
  assert(user.includes(artifact.source.raw_script.trim()), 'Original script must remain intact')
  const dir = path.join(root, 'demo-output', 'chapter-prompt-trial-' + new Date().toISOString().replace(/[:.]/g, '-'))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'before.txt'), baseline.response)
  fs.writeFileSync(path.join(dir, 'system.txt'), system)
  fs.writeFileSync(path.join(dir, 'user.txt'), user)
  const inputTokens = await countInputTokens(config, system, user)
  assert(
    inputTokens !== undefined && inputTokens + config.max_tokens + 512 <= settings.context_tokens,
    'Context budget exceeded',
  )
  console.log(
    JSON.stringify({
      dir,
      model: config.model_name,
      temperature: config.temperature,
      max_tokens: config.max_tokens,
      inputTokens,
    }),
  )
  const start = Date.now()
  const result = await invokeLLMResult(config, system, user)
  fs.writeFileSync(path.join(dir, 'after.txt'), result.content)
  const count = (text: string) => Array.from(text.replace(/\s/gu, '')).length
  const chars = count(result.content)
  const report = {
    baseline_log: baseline.id,
    model: config.model_name,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    input_tokens: inputTokens,
    before_chars: count(baseline.response),
    after_chars: chars,
    target_chars: 4000,
    acceptable_range: [2800, 5200],
    length_ok: chars >= 2800 && chars <= 5200,
    finish_reason: result.finish_reason,
    refusal: result.refusal,
    elapsed_seconds: Math.round((Date.now() - start) / 1000),
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
