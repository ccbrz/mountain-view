/** Authenticated, isolated test of prepare → draft → check → patch preview. No real provider calls. */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'workflow-test-only'

async function main() {
  const {getDB} = await import('../db'), {initSchema} = await import('../schema')
  const {initLogStore} = await import('../llm/logstore')
  const {default: writer} = await import('../routes/writer')
  const db = getDB(); initSchema(); initLogStore()
  const model = Number(db.prepare("INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES ('test','https://workflow.invalid/v1','test','private-test-key')").run().lastInsertRowid)
  const style = '好的，文学评论家在此。写作时对话采用短句，心理可以直接写。不要照抄作品例子。'
  const novel = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config,style_guide,word_number) VALUES ('测试书','author','test',?,4000)").run(style).lastInsertRowid)
  const app = express(); app.use(express.json()); app.use('/novels', writer)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const realFetch = fetch, token = jwt.sign({username: 'author', role: 'user'}, process.env.JWT_SECRET!)
  const req = async (path: string, body?: any, status = 200, auth = token) => {
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}/writer${path}`, {method: body ? 'POST' : 'GET', headers: {Authorization: `Bearer ${auth}`, 'Content-Type':'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})})
    const json: any = await r.json(); assert.equal(r.status, status, JSON.stringify(json)); return json
  }
  const requests: any[] = []
  let response = '', finish = 'stop', failure = false
  let responses: string[] = []
  globalThis.fetch = (async (_url: any, opts: any) => {
    const body = JSON.parse(opts.body); requests.push(body)
    if (failure) throw Error('模拟供应商失败 private-test-key')
    return Response.json({choices:[{message:{content:responses.shift() ?? response},finish_reason:finish}]})
  }) as typeof fetch
  try {
    const project = await req('/project')
    const {requireMemoryTime, parsePreparation} = await import('../llm/writer-preparation')
    assert.throws(() => requireMemoryTime({...project.settings,memory:'已发生事实',memory_through_chapter:undefined},1,'write'),/截至章节/)
    assert.throws(() => requireMemoryTime({...project.settings,memory:'第一章结束状态',memory_through_chapter:1},1,'write'),/不能作为/)
    requireMemoryTime({...project.settings,memory:'第一章结束状态',memory_through_chapter:1},2,'write')
    requireMemoryTime({...project.settings,memory:'第一章当前状态',memory_through_chapter:1},1,'continue')
    const recovered = parsePreparation('{"facts":[{"source":"【设定 · 老赵】","quote":"老赵欠林星河一次撤离承诺。","note：不能写反。"}],"style_rules":[],"conflicts":[]}', [{label:'Lorebook · 老赵',text:'**老赵**欠林星河一次撤离承诺。'}], '', '')
    assert.equal(recovered.facts[0].quote,'老赵**欠林星河一次撤离承诺。')
    const input = {chapter_idx:1, raw_script:'林远舟在酒吧找到老赵。\n老赵同意借船。\n艾拉报告通讯器线索。', title:'借船', author_note:'不确定苏晴的身份', content:'旧草稿不能作为起点', mode:'write', settings:{...project.settings,model_id:String(model),context_tokens:100000,
      memory:'苏晴已经登船，通讯器已发现。',lorebook:[{id:'zhao',title:'老赵',category:'人物',enabled:true,always_on:true,keys:[],text:'老赵欠林星河一次撤离承诺。'}]}}
    const good = {facts:[{source:'Lorebook · 老赵',quote:'老赵欠林星河一次撤离承诺。',note:'欠承诺的是老赵，不能反写。'}],style_rules:[{quote:'对话采用短句，心理可以直接写',rule:'对话偏短；保留有作用的心理直写。'}],conflicts:[]}
    response = JSON.stringify({...good, conflicts:[{source:'Memory',quote:input.settings.memory,plan_quote:'艾拉报告通讯器线索。',problem:'Memory 已把本章结尾记为既成事实，和从酒吧起写的时间点冲突。'}]})
    const conflict = await req('/prepare',input)
    assert(!requests.at(-1).messages[1].content.includes(input.content))
    assert(conflict.preparation.conflicts.length === 1)
    let calls = requests.length
    await req('/generate',{...input,prepared_id:conflict.artifact_id},400)
    assert.equal(requests.length,calls)
    assert.equal((await req('/project')).settings.memory,'')
    console.log('✓ 写前核对显示可定位的 Memory 时间冲突，阻止正文调用，不改权威记忆')

    input.settings.memory = '林远舟尚未见过苏晴。'
    response = JSON.stringify({...good,facts:[{...good.facts[0],quote:'伪造的依据'}]})
    assert((await req('/prepare',input)).preparation_warning)
    response = JSON.stringify(good); const prepared = await req('/prepare',input)
    calls = requests.length
    await req('/generate',{...input,author_note:'已改批注',prepared_id:prepared.artifact_id},409)
    assert.equal(requests.length,calls)
    response = '开头。林星河欠老赵一次撤离承诺。其余段落🛰️保持原样。结尾。'
    const drafted = await req('/generate',{...input,prepared_id:prepared.artifact_id})
    assert.equal(drafted.content,response)
    const prompt = requests.at(-1)
    assert(!prompt.messages[0].content.includes(good.style_rules[0].rule))
    assert(prompt.messages[0].content.includes(style))
    assert(prompt.messages[1].content.includes('本章停笔点：艾拉报告通讯器线索。'))
    assert(prompt.messages[1].content.includes(good.facts[0].quote))
    assert(!prompt.messages[1].content.includes(input.content))
    console.log('✓ 整章起点、顺序与落点显式传入；完整文风指南不被写前核对压缩；过期核对不复用')

    const checkedSource = {...input,content:drafted.content,incomplete:false}
    const issue = {layer:'故事',resolution:'local',evidence:[{source:'Lorebook · 老赵',quote:'老赵欠林星河一次撤离承诺。'}],dimension:'设定一致性',severity:'必改',problem:'撤离承诺的关系写反',quote:'林星河欠老赵一次撤离承诺。',suggestion:'按设定改成老赵欠林星河，不新增死伤背景。'}
    response = JSON.stringify({summary:'人物关系写反，需要修订。',beats:[1,2,3].map(point => ({point,status:'已写',quote:'开头。'})),issues:[issue,{...issue,quote:'正文并无这句话',problem:'不受支持的意见'}],scores:{prose:20,consistency:5,webnovel:15}})
    const checked = await req('/check',checkedSource)
    assert.equal(checked.length.status,'short'); assert.equal(checked.length.chars,Array.from(checkedSource.content.replace(/\s/gu,'')).length)
    assert.equal((await req('/chapter/1')).content,'') // Inspection never saves the supplied candidate.
    calls = requests.length
    await req('/repair',{...checkedSource,content:'已修改正文',check_id:checked.artifact_id},409)
    assert.equal(requests.length,calls)
    response = JSON.stringify([{note:'恢复已有关系',find:issue.quote,replace:'老赵欠林星河一次撤离承诺。'},{note:'无效定位',find:'不存在',replace:'不要新增'}])
    responses = [response, JSON.stringify({patches:[{index:1,status:'safe',reason:'恢复设定中的债务方向',evidence:issue.evidence}]})]
    const repaired = await req('/repair',{...checkedSource,check_id:checked.artifact_id})
    assert.equal(repaired.applied.length,1); assert.equal(repaired.failed.length,1)
    assert.equal(repaired.content,checkedSource.content.replace(issue.quote,'老赵欠林星河一次撤离承诺。'))
    assert.equal((await req('/chapter/1')).content,'')
    assert(repaired.contexts.revision.user_prompt.includes('仅落实修改要求'))
    assert(repaired.context.user_prompt.includes('逐条核验 JSON'))
    assert(!repaired.context.user_prompt.includes('文风整理依据'))
    console.log('✓ 自动审读区分字数和台本问题；修订只生成精确补丁候选，失败定位与其他段落保留')

    // The same bounded pipeline handles different genres; no story-specific keyword rules.
    for (const scenario of [
      {name:'悬疑证据归属', content:'钟表匠借给旅客一把钥匙。钥匙刻着徽记。她一定是王室成员。', quote:'她一定是王室成员。', replacement:'她或许与王室有关。', status:'safe', reason:'按现有线索降低判断强度'},
      {name:'奇幻凭空加能力', content:'药师收起伤药。门外传来脚步。', quote:'门外传来脚步。', replacement:'她用读心术得知刺客来袭。', status:'reject', reason:'原稿和设定没有读心能力，凭空增加关键能力和情报'},
      {name:'都市补动机', content:'顾客拒绝签字。双方沉默。', quote:'双方沉默。', replacement:'因为对方曾毁掉他的公司，他始终无法原谅。', status:'author_decision', reason:'需要作者决定的历史与动机，不能新增'},
      {name:'表达删除重复', content:'雨打着屋檐。雨敲在屋檐上。她推开窗。', quote:'雨敲在屋檐上。', replacement:'', status:'safe', reason:'删除重复环境信息，保留动作与衔接'},
    ]) {
      const source = {...checkedSource, content:scenario.content}
      const finding = {...issue,layer:scenario.name.startsWith('表达') ? '表达' : '故事',problem:scenario.name,quote:scenario.quote,suggestion:'根据已有材料最小修复',evidence:[{source:'本章现有正文',quote:scenario.quote}]}
      responses = [JSON.stringify({summary:scenario.name,beats:[1,2,3].map(point=>({point,status:'漏写',quote:''})),issues:[finding],scores:{prose:25,consistency:15,webnovel:20}}),
        JSON.stringify([{note:scenario.name,find:scenario.quote,replace:scenario.replacement}]),
        JSON.stringify({patches:[{index:1,status:scenario.status,reason:scenario.reason,evidence:finding.evidence}]})]
      calls = requests.length
      const refined = await req('/refine',source)
      assert.equal(requests.length - calls,3)
      assert.equal(refined.applied.length,scenario.status === 'safe' ? 1 : 0)
      assert.equal(refined.blocked.length,scenario.status === 'safe' ? 0 : 1)
      assert.equal(refined.content,scenario.status === 'safe' ? scenario.content.replace(scenario.quote,()=>scenario.replacement) : scenario.content)
      assert.equal(refined.length.chars,Array.from(refined.content.replace(/\s/gu,'')).length)
      assert.equal((await req('/chapter/1')).content,'')
    }
    const failSource = {...checkedSource,content:'重复描述。重复描述的意思。'}
    const failFinding = {...issue,layer:'表达',quote:'重复描述的意思。',evidence:[{source:'本章现有正文',quote:'重复描述。'}]}
    responses = [JSON.stringify({summary:'可精简',issues:[failFinding],beats:[],scores:{prose:20,consistency:15,webnovel:20}}),JSON.stringify([{note:'删除重复',find:failFinding.quote,replace:''}]),'invalid audit']
    const failAudit = await req('/refine',failSource)
    assert.equal(failAudit.content,failSource.content); assert.equal(failAudit.applied.length,0); assert.equal(failAudit.blocked.length,1); assert(failAudit.audit.warning)
    // A patch unrelated to the diagnosed quote must never reach the model audit or candidate.
    responses = [JSON.stringify({summary:'可精简',issues:[failFinding],beats:[],scores:{prose:20,consistency:15,webnovel:20}}),JSON.stringify([{note:'擅自改别处',find:'重复描述。',replace:'新增秘密。'}])]
    calls = requests.length
    const unrelated = await req('/refine',failSource)
    assert.equal(requests.length-calls,2); assert.equal(unrelated.content,failSource.content); assert.equal(unrelated.blocked.length,1)
    const {parseRefinementAudit} = await import('../llm/writer-refinement')
    for (const raw of ['broken', '{"patches":[]}', JSON.stringify({patches:[{index:1,status:'safe',reason:'好',evidence:[{source:'本章现有正文',quote:'伪造引用'}]}]}), JSON.stringify({patches:[{index:1,status:'safe',reason:'好',evidence:[{source:'修改要求',quote:'新增设定'}]}]})]) {
      assert.equal(parseRefinementAudit(raw,1,[{label:'本章现有正文',text:'原稿'}]).decisions[0].status,'reject')
    }
    const decisionSource = {...checkedSource, content:'陌生人拒绝同行。'}
    responses = [JSON.stringify({summary:'需要作者给出动机',issues:[{...issue,resolution:'author_decision',quote:decisionSource.content,suggestion:'请作者确定理由'}],beats:[],scores:{prose:25,consistency:15,webnovel:20}})]
    calls = requests.length
    const decision = await req('/refine',decisionSource)
    assert.equal(requests.length - calls,1); assert.equal(decision.applied.length,0); assert.equal(decision.author_decisions.length,1)
    // High scores and a claimed local fix cannot bypass missing source evidence.
    responses = [JSON.stringify({summary:'声称可改',issues:[{...issue,quote:decisionSource.content,evidence:[{source:'Memory',quote:'不存在'}]}],beats:[],scores:{prose:25,consistency:15,webnovel:20}})]
    calls = requests.length
    assert.equal((await req('/refine',decisionSource)).applied.length,0); assert.equal(requests.length - calls,1)
    console.log('✓ 一键精修跨悬疑、奇幻、都市和表达问题：先诊断再改稿再核验，不增设定、不升级推断；无依据/无效核验不放行')

    failure = true
    const error = await req('/check',checkedSource,400)
    assert(!error.message.includes('private-test-key')); assert.equal((await req('/chapter/1')).content,'')
    failure = false; finish = 'length'; response = '{"facts":[]'
    assert((await req('/prepare',input)).preparation_warning)
    finish = 'stop'; response = 'invalid'; assert((await req('/prepare',input)).preparation_warning)
    calls = requests.length
    for (const path of ['/prepare','/check','/repair','/refine']) {
      await req(path,input,401,'')
      await req(path,input,404,jwt.sign({username:'someone-else',role:'user'},process.env.JWT_SECRET!))
    }
    assert.equal(requests.length,calls)
    db.prepare('UPDATE novels SET context_revision=context_revision+1 WHERE id=?').run(novel)
    await req('/repair',{...checkedSource,check_id:checked.artifact_id},409)
    assert.equal(requests.length,calls)
    console.log('✓ 失败/截断/无效 JSON 不丢稿；新接口鉴权、密钥脱敏与设定版本冲突保护有效')
  } finally { globalThis.fetch = realFetch; await new Promise<void>(r => server.close(() => r())); db.close() }
}
main().catch(e => {console.error(e);process.exitCode=1})
