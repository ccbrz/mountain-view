/** Original-source style previews and adoption; isolated DB and provider, never edits a real novel. */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'style-check-only'

async function main() {
  const {getDB} = await import('../db'), {initSchema} = await import('../schema')
  const {initLogStore} = await import('../llm/logstore')
  const {default: router} = await import('../routes/novel-generator')
  const {sampleStyleSources, styleEvidenceCatalog, parseStyleAnalysis, renderStyleGuide, selectStyleSamples, STYLE_DOC, LEGACY_STYLE_SAMPLE} = await import('../llm/writer-style')
  const {buildWriterContext} = await import('../llm/writer-context')
  const {bumpContextRevision} = await import('../llm/doc-snapshots')
  const db = getDB(); initSchema(); initLogStore()
  const contextRevision = (db: any, id: number) => db.prepare('SELECT context_revision FROM novels WHERE id=?').get(id).context_revision
  db.prepare("INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES ('mock','https://style-test.invalid/v1','mock','private-test-key')").run()
  db.prepare("INSERT INTO novels(title,creator_username,llm_config,style_guide,style_reference) VALUES ('测试书','author','mock','保留作者完整指南。','作者手动示例。')").run()
  const app = express(); app.use(express.json({limit:'4mb'})); app.use('/novels', router)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const realFetch = fetch, token = jwt.sign({username:'author',role:'user'}, process.env.JWT_SECRET!)
  const req = async (path: string, body?: any, method = body ? 'POST' : 'GET', status = 200, auth = token) => {
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/1/style/${path}`, {
      method, headers: {Authorization:`Bearer ${auth}`,'Content-Type':'application/json'}, ...(body ? {body:JSON.stringify(body)} : {}),
    })
    const data: any = await r.json(); assert.equal(r.status, status, JSON.stringify(data)); return data
  }
  let calls = 0, invalid = false, mixed = false, fail = false
  globalThis.fetch = (async (url: any, opts: any) => {
    assert(String(url).startsWith('https://style-test.invalid/')); calls++
    if (fail) throw Error('private-test-key unavailable')
    const request = JSON.parse(opts.body), text = request.messages[1].content
    assert(request.temperature <= 0.3)
    const samples = JSON.parse(text.slice(text.indexOf('[{'), text.lastIndexOf('}]') + 2))
    assert(samples.every((s:any)=>Array.isArray(s.sentences) && !('text' in s)))
    const observations = samples.slice(0, 3).map((s: any, i: number) => ({advice:`${['叙述','对白','动作'][i]}保持具体的节奏和停顿。`, dimension:['叙述语气','对话语气','动作描写'][i], evidence_ids:[invalid ? 'S999.999' : s.sentences[0].id]}))
    if (mixed) observations.push({...observations[0],evidence_ids:['S1.99999']})
    return Response.json({choices:[{message:{content:JSON.stringify({observations})},finish_reason:'stop'}]})
  }) as typeof fetch
  try {
    const source = Array.from({length:3000}, (_, i) => `第${i}处。她放下茶杯，等他先开口。`).join('')
    const samples = sampleStyleSources(source)
    assert(samples.length <= 12 && samples.length >= 3)
    assert(samples.some(s => s.start > source.length * 0.8), 'must sample late prose too')
    assert(samples.every(s => source.slice(s.start, s.start + s.text.length) === s.text))
    assert(samples.reduce((n,s)=>n+s.text.length,0) <= 14400)
    const files = [source, '第二份。'.repeat(25), '第三份。'.repeat(40)]
    const multi = sampleStyleSources(files.join('\n\n---\n\n'))
    assert.deepEqual([...new Set(multi.map(s=>s.source))], [1,2,3])
    assert(multi.every(s => files[s.source-1].slice(s.start,s.start+s.text.length) === s.text))
    assert.deepEqual(sampleStyleSources(''), [])
    const catalog=styleEvidenceCatalog(samples)
    assert(catalog.length>samples.length)
    assert(catalog.every(e=>samples.find(s=>s.id===e.sample_id)!.text.includes(e.quote)))
    assert.equal(new Set(catalog.map(e=>e.id)).size,catalog.length)
    const anchors=[catalog[0],catalog.find(e=>e.sample_id!==catalog[0].sample_id)!]
    const indexed=parseStyleAnalysis(JSON.stringify({observations:[{dimension:'外貌与体态',advice:'局部观察：以衣着和姿态勾勒轮廓，不罗列所有五官。',evidence_ids:anchors.map(e=>e.id),quote:'模型即使自行抄写引文也不作为依据'}]}),samples,undefined,true)
    assert.deepEqual(indexed.observations[0].evidence,anchors.map(({sample_id,quote})=>({sample_id,quote})))
    assert(renderStyleGuide(indexed).startsWith('【外貌与体态】'))
    const damaged=JSON.stringify({observations:[{dimension:'动作描写',advice:'拆解动作的具体过程。',evidence_ids:anchors.map(e=>e.id)}]}).replace('"advice":"','"advice":：')
    assert.equal(parseStyleAnalysis(damaged,samples,undefined,true).observations[0].advice,'拆解动作的具体过程。')
    const brokenKey=damaged.replace('"advice":：','"advice：')
    assert.equal(parseStyleAnalysis(brokenKey,samples,undefined,true).observations[0].advice,'拆解动作的具体过程。')
    assert.throws(()=>parseStyleAnalysis(JSON.stringify({observations:[{dimension:'叙述语气',advice:'用第一人称来讲述。',evidence_ids:[anchors[0].id]}]}),samples,undefined,true),/无法在取样原文/)
    assert.equal(parseStyleAnalysis(JSON.stringify({observations:[{advice:'作者手动保留第一人称偏好。',sample_id:anchors[0].sample_id,quote:anchors[0].quote,kind:'通用'}]}),samples).observations.length,1)
    const badSecondary=structuredClone(indexed);badSecondary.observations[0].evidence![1].quote='杜撰的第二处证据';
    const {validateStyleProfile}=await import('../llm/writer-style');assert.throws(()=>validateStyleProfile(badSecondary),/无法在取样原文/)
    assert(!renderStyleGuide(indexed).includes(anchors[0].quote))
    const old=parseStyleAnalysis(JSON.stringify({observations:[{advice:'保留旧指南。',sample_id:anchors[0].sample_id,quote:anchors[0].quote,kind:'通用'}]}),samples)
    assert.equal(old.observations[0].advice,'保留旧指南。')
    assert.throws(()=>parseStyleAnalysis(JSON.stringify({observations:[{dimension:'外貌与体态',advice:'不能只靠旧引文绕过编号。',sample_id:anchors[0].sample_id,quote:anchors[0].quote}]}),samples,undefined,true),/无法在取样原文/)
    console.log('✓ 编号原句逐字回填，多段依据与外貌维度保留；指南不抄引文，旧档案可读，新提取不能绕过编号')

    const before = await req('profile'), revision = contextRevision(db,1)
    assert.equal(before.profile.samples[0].id,LEGACY_STYLE_SAMPLE)
    assert.equal(before.profile.samples[0].manual,true)
    assert.equal(before.profile.samples[0].preferred,true)
    assert.equal((db.prepare('SELECT style_reference FROM novels WHERE id=1').get() as any).style_reference,'作者手动示例。', 'viewing must not write a migration')
    const candidate = await req('guide',{content: source})
    assert.equal(calls,1); assert.equal(candidate.base_revision,before.revision)
    assert.deepEqual(candidate.missing_dimensions,['场景描写','外貌与体态'])
    assert(candidate.style_guide.includes('【叙述语气】') && candidate.style_guide.includes('【对话语气】') && candidate.style_guide.includes('【动作描写】'))
    assert.deepEqual(await req('profile'),before, 'extracting or discarding must not overwrite persisted style')
    assert.equal(contextRevision(db,1), revision)
    mixed=true; const partial = await req('guide',{content:source}); mixed=false
    assert.equal(partial.skipped_count,1); assert.equal(partial.profile.observations.length,3)
    assert.equal(partial.style_guide,candidate.style_guide)
    assert(!partial.style_guide.includes(candidate.profile.observations[0].quote), 'guide is advice, not source quotations')
    assert.deepEqual(await req('profile'),before)
    invalid=true; const unsupported = await req('guide',{content: source},'POST',502); invalid=false
    assert.match(unsupported.message,/均未通过核对/)
    console.log('✓ 部分引用错误只剔除对应建议；全部无依据才停止，指南仅含提炼后的写法，不拼接原文')
    assert.deepEqual(await req('profile'),before)
    await req('guide',{content:12},'POST',400)
    const foreign = jwt.sign({username:'someone-else',role:'user'},process.env.JWT_SECRET!)
    await req('profile',undefined,'GET',404,foreign)
    await req('guide',{...candidate},'PUT',404,foreign)
    console.log('✓ 分散取样覆盖首尾与多文件；候选不落库；伪造引文和越权访问被拒绝')

    bumpContextRevision(db,1) // An unrelated prose save should not invalidate a style-only candidate.
    const accepted = await req('guide',{...candidate,style_guide:'作者修改后的完整指南。对话保留停顿，动作有清楚落点。'},'PUT')
    assert.equal(accepted.style_guide,'作者修改后的完整指南。对话保留停顿，动作有清楚落点。')
    assert.equal((db.prepare('SELECT style_reference FROM novels WHERE id=1').get() as any).style_reference,'')
    assert.equal(accepted.profile.samples.filter((s:any)=>s.id===LEGACY_STYLE_SAMPLE).length,1, 'legacy content migrates once on explicit save')
    assert.equal(contextRevision(db,1),revision+2)
    assert(db.prepare('SELECT content FROM novel_docs WHERE novel_id=1 AND doc_type=?').get(STYLE_DOC))
    await req('guide',candidate,'PUT',409)
    await req('reference',{content:'陈旧页面的示例',base_revision:before.revision},'PUT',409)
    const bad = structuredClone(accepted.profile); bad.observations[0].quote = '伪造的引文'
    await req('guide',{...accepted,base_revision:accepted.revision,profile:bad},'PUT',400)
    assert.equal((await req('profile')).revision,accepted.revision)

    const novel = db.prepare('SELECT * FROM novels WHERE id=1').get() as any
    const selected = selectStyleSamples(db, novel, '动作与交火')
    assert.equal(selected.length,2); assert.equal(selected[0].id,LEGACY_STYLE_SAMPLE); assert.equal(selected[1].kind,'动作')
    assert(selected.reduce((n,s)=>n+Array.from(s.text).length,0)<=2000)
    const settings = {model_id:'1',system_prompt:'保持简体中文。',temperature:0.7,recent_context_chars:6000,context_tokens:100000,max_output_tokens:8192,memory:'',lorebook:[]}
    const input:any = {chapter_idx:1,title:'对话',raw_script:'交谈后逃跑。',author_note:'这次对白更舒缓',content:'',settings,
      preparation:{facts:[],conflicts:[],style_rules:[{rule:'不应覆盖完整指南的旧摘要',quote:'旧引文'}]}}
    const ctx = buildWriterContext(db,novel,input)
    assert(ctx.system_prompt.includes(accepted.style_guide))
    assert(!ctx.system_prompt.includes('不应覆盖完整指南的旧摘要'))
    assert(ctx.blocks.filter(b=>b.label.startsWith('范文参考')).length===2)
    const prepared = buildWriterContext(db,novel,input,'prepare')
    assert(!prepared.blocks.some(b=>/范文|待整理文风/.test(b.label)))
    const small = buildWriterContext(db,novel,{...input,settings:{...settings,context_tokens:1024,max_output_tokens:128}})
    assert(!small.blocks.some(b=>b.label.startsWith('范文参考')), 'optional examples must yield to essential context')
    console.log('✓ 显式保存支持作者修改与版本冲突保护；完整指南与真实范文进入生成，预算不足先移除范文')

    const cleared = await req('reference',{content:'',base_revision:accepted.revision},'PUT')
    assert(cleared.revision!==accepted.revision)
    const disabled = structuredClone(accepted.profile); disabled.samples.forEach((s:any)=>s.enabled=false)
    await req('guide',{style_guide:accepted.style_guide,profile:disabled,base_revision:cleared.revision},'PUT')
    assert.equal(selectStyleSamples(db,db.prepare('SELECT * FROM novels WHERE id=1').get(),'对话').length,0)
    const current = await req('profile')
    const manual = {version:1, samples:[
      {id:'manual-one',source:0,start:0,text:'作者手选的第一段。',enabled:true,manual:true,preferred:false},
      {id:'manual-two',source:0,start:0,text:'作者优先选用的第二段。',enabled:true,manual:true,preferred:true},
    ], observations:[]}
    const savedManual = await req('guide',{style_guide:accepted.style_guide,profile:manual,base_revision:current.revision},'PUT')
    assert.deepEqual(selectStyleSamples(db,db.prepare('SELECT * FROM novels WHERE id=1').get(),'对话').map(s=>s.id),['manual-two','manual-one'])
    const reextract = await req('guide',{content:source})
    assert.deepEqual(reextract.profile.samples.filter((s:any)=>s.manual),manual.samples, 're-extraction must retain author-picked text and priorities')
    assert.deepEqual((await req('profile')).profile,manual, 'preview still cannot overwrite manual edits')
    const invalidPriority=structuredClone(manual); (invalidPriority.samples[0] as any).preferred='true'
    await req('guide',{style_guide:accepted.style_guide,profile:invalidPriority,base_revision:savedManual.revision},'PUT',400)
    const emptied=await req('guide',{style_guide:accepted.style_guide,profile:{version:1,samples:[],observations:[]},base_revision:savedManual.revision},'PUT')
    assert.equal(selectStyleSamples(db,db.prepare('SELECT * FROM novels WHERE id=1').get(),'对话').length,0)
    const compatible=await req('reference',{content:'旧客户端新增的片段。',base_revision:emptied.revision},'PUT')
    assert.equal((await req('profile')).profile.samples[0].text,'旧客户端新增的片段。')
    assert.equal((db.prepare('SELECT style_reference FROM novels WHERE id=1').get() as any).style_reference,'')
    await req('reference',{content:'',base_revision:compatible.revision},'PUT')
    assert.equal((await req('profile')).profile.samples.length,0)
    console.log('✓ 手动范文无损迁入统一库；优先排序、无提取指南也可添加、重提取保留手动项、清空与旧接口兼容有效')
    fail=true; const error=await req('guide',{content:source},'POST',502); assert(!error.message.includes('private-test-key'))
    assert.equal((await req('profile')).style_guide,accepted.style_guide)
    console.log('✓ 旧手动范文可清除、锚点可停用；失败保留指南并脱敏凭证')
  } finally {
    globalThis.fetch=realFetch; server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); db.close()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
