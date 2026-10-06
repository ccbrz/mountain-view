/** 人工工作流的接口回归：业务库不变，AI 仅提供可失败/可误报的建议。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'human-review-check-only'

async function main() {
  const {getDB} = await import('../db')
  const {initSchema} = await import('../schema')
  const {initVectorStore} = await import('../llm/vectorstore')
  const {initLogStore} = await import('../llm/logstore')
  const {requireProgressBeforeChapter} = await import('../llm/doc-snapshots')
  const {default:generator} = await import('../routes/novel-generator')
  const db=getDB(); initSchema(); initVectorStore(); initLogStore()
  db.prepare("INSERT INTO llm_configs(name,base_url,model_name) VALUES ('mock','https://human-review.invalid','mock')").run()
  const id=Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config,embedding_config) VALUES ('人工恢复','author','mock','mock')").run().lastInsertRowid)
  for (const [n,body] of [[1,'黑陶碗下压着七粒白石，用来记录补完的七张渔网。调包者是谁？'],[2,'罗衡调包为掩盖私盐，四人读完证据，谜团解开。'],[3,'下一章草稿。']] as const) {
    db.prepare("INSERT INTO novel_chapters(novel_id,chapter_number,content,status,word_count) VALUES (?,?,?,'needs_review',?)").run(id,n,body,body.length)
  }
  const app=express(); app.use(express.json()); app.use('/novels',generator)
  const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r))
  const realFetch=globalThis.fetch
  let calls=0, offline=false
  let gate: {entered:()=>void;wait:Promise<void>} | undefined
  globalThis.fetch=(async (url:any,options:any)=>{
    assert(String(url).startsWith('https://human-review.invalid/'))
    calls++; if(offline) throw new Error('模拟模型不可用')
    const body=JSON.parse(options.body), extraction=body.messages[0].content.startsWith('你是小说的连载编辑')
    if(extraction && gate) {const held=gate;gate=undefined;held.entered();await held.wait}
    const content=extraction ? {summary:'罗衡换账为掩盖私盐。',facts:[],hooks:[{op:'mention',id:'H1'}],handoff:{scene:'诊室'}}
      : {issues:[{problem:'模拟误报：已知的普通动作被误判',candidate_id:'C1',evidence_id:'S1'}]}
    return Response.json({choices:[{message:{content:JSON.stringify(content)}}]})
  }) as typeof fetch
  const token=jwt.sign({username:'author',role:'user'},process.env.JWT_SECRET!)
  const request=async(n:number,method:string,body:any={},expected=200,who=token)=>{
    const r=await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${id}/chapters/${n}/memory-review`,{
      method,headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},body:JSON.stringify(body),
    }); const data:any=await r.json();assert.equal(r.status,expected,JSON.stringify(data));return data
  }
  const chapter=(n:number)=>db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=?').get(id,n) as any
  const revision=()=> (db.prepare('SELECT context_revision FROM novels WHERE id=?').get(id) as any).context_revision
  const saved=(n:number)=> db.prepare('SELECT * FROM novel_memory_reviews WHERE chapter_id=?').get(chapter(n).id) as any
  const complete=(memory:any,summary:string)=>({...memory,summary,handoff:{scene:'季叔家',doing:'准备离开',pending:'',mood:'平静',lastLines:''}})
  const confirm=(n:number,r:any)=>request(n,'PUT',{review_id:r.review_id,memory:r.memory,confirm:true})
  try {
    await request(2,'POST',{},409)
    let first=await request(1,'POST')
    assert.equal(calls,0);assert.equal(revision(),0)
    first.memory=complete(first.memory,'七粒白石记录已补好的七张渔网，调包者仍未知。')
    first.memory.facts=[{kind:'item',subject:'碗底白石',predicate:'状态',value:'七粒白石，记录当天补好的七张渔网'}]
    first.memory.hooks=[{content:'谁调换航道账，动机是什么？'}]
    const oldToken=first.review_id
    first=await request(1,'PUT',{review_id:first.review_id,memory:first.memory})
    assert.notEqual(first.review_id,oldToken)
    assert.deepEqual((await request(1,'POST')).memory,first.memory)
    assert.equal((db.prepare('SELECT count(*) AS n FROM novel_doc_snapshots').get() as {n:number}).n,0)
    await confirm(1,first)
    assert.equal(calls,0);assert.equal(chapter(1).status,'finalized');assert.equal(saved(1).reviewed_by,'author')
    assert.match(requireProgressBeforeChapter(db,id,2)!.summaries[0].text,/七粒/)
    console.log('✓ 旧正文不重写，核对草稿持久保存，纯手工确认恢复下一章进度')

    let second=await request(2,'POST')
    second=await request(2,'POST',{review_id:second.review_id,suggest:true})
    assert(second.issues.length>0);assert.equal(second.memory.hooks.length,1)
    assert.equal(chapter(2).status,'needs_review')
    second.memory=complete(second.memory,'罗衡调包为掩盖私盐，四人已知，原谜团已经解决。')
    second.memory.hooks=[]
    const callsBefore=calls
    await confirm(2,second)
    assert.equal(calls,callsBefore,'人工确认不得调用模型或 Embedding')
    assert.equal(requireProgressBeforeChapter(db,id,3)!.hooks.length,0)
    assert.match(requireProgressBeforeChapter(db,id,3)!.facts[0].value,/七粒/)
    assert(JSON.parse(saved(2).content).issues.length>0)
    assert.equal(JSON.parse(saved(2).accepted_content).hooks.length,0)
    console.log('✓ 审校误报不否决作者；作者关闭伏笔、确认准确数量，下一章使用修正后的记忆')

    let third=await request(3,'POST')
    third.memory=complete(third.memory,'已保存的手工摘要')
    third=await request(3,'PUT',{review_id:third.review_id,memory:third.memory})
    offline=true
    third=await request(3,'POST',{review_id:third.review_id,suggest:true})
    assert.match(third.notices.join(' '),/模拟模型不可用/)
    assert.equal(third.memory.summary,'已保存的手工摘要')
    const offlineCalls=calls
    await confirm(3,third);assert.equal(calls,offlineCalls)
    offline=false
    console.log('✓ AI 故障保留手工草稿，作者仍可定稿，向量故障不阻塞确认')

    let reopened=await request(1,'POST')
    const bad=structuredClone(reopened.memory);bad.facts[0].predicate='持有人';bad.facts[0].value=bad.facts[0].subject
    const before=revision()
    await request(1,'PUT',{review_id:reopened.review_id,memory:bad,confirm:true},400)
    assert.equal(revision(),before)
    await request(1,'PUT',{memory:reopened.memory,confirm:true},409)
    const outsider=jwt.sign({username:'outsider',role:'user'},process.env.JWT_SECRET!)
    await request(1,'POST',{},404,outsider)
    console.log('✓ 人工确认仍检查结构、身份和草稿版本，不能写入自持有或伪造版本')

    const originalBodies=[1,2,3].map(n=>chapter(n).content)
    reopened.memory.summary='作者补充：七粒白石只是记补网数，不是暗号。'
    await confirm(1,reopened)
    assert.deepEqual([1,2,3].map(n=>chapter(n).content),originalBodies)
    assert.equal(chapter(2).status,'needs_review');assert.equal(chapter(3).status,'needs_review')
    await request(3,'POST',{},409)
    console.log('✓ 修正已定稿章的记忆使后续待核对，保留正文，禁止跳过前章')

    let draft=await request(2,'POST')
    let entered!:()=>void,release!:()=>void
    const reached=new Promise<void>(r=>entered=r), wait=new Promise<void>(r=>release=r)
    gate={entered,wait}
    const generating=request(2,'POST',{review_id:draft.review_id,suggest:true},409)
    await reached
    draft.memory=complete(draft.memory,'模型工作期间作者保存的摘要')
    draft=await request(2,'PUT',{review_id:draft.review_id,memory:draft.memory})
    release();await generating
    assert.equal((await request(2,'POST')).memory.summary,'模型工作期间作者保存的摘要')
    console.log('✓ 迟到的 AI 整理不能覆盖作者刚保存的核对草稿')

    const edit=await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${id}/chapters/2`,{method:'PUT',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({content:'作者改过的第二章正文。'})})
    assert.equal(edit.status,200)
    await request(2,'PUT',{review_id:draft.review_id,memory:draft.memory,confirm:true},409)
    console.log('✓ 正文改变后旧核对结果不能提交，必须基于新正文重新核对')

    draft=await request(2,'POST');draft.memory=complete(draft.memory,'作者重新核对后的第二章摘要')
    const snapshotBefore=db.prepare('SELECT * FROM novel_doc_snapshots').all(), versionBefore=revision()
    db.exec("CREATE TRIGGER fail_human_snapshot BEFORE INSERT ON novel_doc_snapshots BEGIN SELECT RAISE(ABORT,'模拟写入失败'); END")
    await request(2,'PUT',{review_id:draft.review_id,memory:draft.memory,confirm:true},400)
    db.exec('DROP TRIGGER fail_human_snapshot')
    assert.equal(revision(),versionBefore);assert.deepEqual(db.prepare('SELECT * FROM novel_doc_snapshots').all(),snapshotBefore)
    assert(!saved(2).reviewed_at)
    await confirm(2,draft)
    console.log('✓ 人工确认事务失败整体回滚，重试后可继续下一章')

    db.exec('ALTER TABLE novels DROP COLUMN context_revision')
    const bodiesBeforeMigration=[1,2,3].map(n=>chapter(n).content)
    initSchema();initVectorStore()
    assert.deepEqual([1,2,3].map(n=>chapter(n).content),bodiesBeforeMigration)
    assert.equal((db.prepare('SELECT count(*) AS n FROM novel_memory_reviews').get() as {n:number}).n,0)
    db.prepare("UPDATE novels SET llm_config='',embedding_config='' WHERE id=?").run(id)
    const migrationCalls=calls
    for(let n=1;n<=3;n++) {const r=await request(n,'POST');r.memory=complete(r.memory,`作者核对第${n}章的摘要`);await confirm(n,r)}
    assert.equal(calls,migrationCalls);assert([1,2,3].every(n=>chapter(n).status==='finalized'))
    assert.equal(requireProgressBeforeChapter(db,id,4)!.chapter,3)
    console.log('✓ 升级后无需模型或重写正文，逐章人工确认可恢复完整有效前缀')
  } finally {
    globalThis.fetch=realFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
