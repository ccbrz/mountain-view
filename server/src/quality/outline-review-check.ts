/** 台本人工采纳回归：内存数据库与模拟模型，不修改业务小说。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH=':memory:'
process.env.JWT_SECRET='outline-review-test-only'

async function main(){
  const {getDB}=await import('../db')
  const {initSchema}=await import('../schema')
  const {initVectorStore}=await import('../llm/vectorstore')
  const {initLogStore}=await import('../llm/logstore')
  const {default:router}=await import('../routes/novel-generator')
  const db=getDB();initSchema();initVectorStore();initLogStore()
  db.prepare("INSERT INTO llm_configs(name,base_url,model_name) VALUES ('mock','https://outline-test.invalid','mock')").run()
  const novelId=Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('台本测试','author','mock')").run().lastInsertRowid)
  const original='阿迟问：「你早就知道了？」林砚没有看他：「我知道的，比你希望的少。」阿迟捏住账角。林砚合上账本。'
  const chapterId=Number(db.prepare("INSERT INTO novel_chapters(novel_id,chapter_number,outline,content,status,index_status) VALUES (?,1,?,'原正文','finalized','ready')").run(novelId,original).lastInsertRowid)
  db.prepare('INSERT INTO novel_chapters(novel_id,chapter_number) VALUES (?,2)').run(novelId)
  const app=express();app.use(express.json());app.use('/novels',router)
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r))
  const token=jwt.sign({username:'author',role:'user'},process.env.JWT_SECRET!)
  const outsider=jwt.sign({username:'other',role:'user'},process.env.JWT_SECRET!)
  const realFetch=globalThis.fetch
  let calls=0,invalid=false,compress=false,gate:{entered:()=>void;wait:Promise<void>}|undefined
  globalThis.fetch=(async(url:any,options:any)=>{
    assert(String(url).startsWith('https://outline-test.invalid/'));calls++
    const body=JSON.parse(options.body)
    assert.match(body.messages[0].content,/默认保留作者全部对白原句/)
    assert.match(body.messages[0].content,/只能写到 suggestions，不能进入 outline/)
    assert.match(body.messages[1].content,compress?/允许压缩非关键对白/:/保留全部对白原句/)
    if(gate){const held=gate;gate=undefined;held.entered();await held.wait}
    return Response.json({choices:[{message:{content:invalid?'不是 JSON':JSON.stringify({outline:`【场景一】旧仓库\n发生：${original}\n落点：林砚合上账本。`,suggestions:[{text:'不揭示：幕后买家身份。',reason:'作者未安排揭晓。'}],notes:['数量可能不一致，请作者核对。']})}}]})
  }) as typeof fetch
  const req=async(path:string,method='GET',body?:any,status=200,who=token)=>{
    const response=await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novelId}${path}`,{method,headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const data:any=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data
  }
  const url='/chapters/1/outline-review'
  const chapter=()=>db.prepare('SELECT * FROM novel_chapters WHERE id=?').get(chapterId) as any
  const generate=async(status=200)=>{const d=await req(url);return req('/polish/outline/1','POST',{outline_revision:d.outline_revision,review_id:d.review?.review_id,compress_dialogue:compress},status)}
  const save=(r:any,confirm=false,status=200)=>req(url,'PUT',{review_id:r.review_id,outline:r.outline,selected:r.selected,confirm},status)
  const edit=async(text:string)=>req('/chapters/1','PUT',{outline:text,outline_revision:chapter().outline_revision})
  const hold=()=>{let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);gate={entered,wait};return{reached,release}}
  try{
    let r=await generate()
    assert.equal(chapter().outline,original);assert.equal(chapter().outline_revision,0)
    assert.equal(r.selected.length,0);assert(!r.outline.includes(r.suggestions[0].text));assert.deepEqual((await req(url)).review,r)
    r.outline+='\n作者补充：保留阿迟的反应。'
    const old=r;r=await save(r);assert.notEqual(r.review_id,old.review_id);await save(old,false,409)
    assert.equal((await req(url)).review.outline,r.outline)
    console.log('✓ 整理不覆盖原稿，建议默认分离；候选可编辑、持久保存且有并发版本保护')

    const beforeCalls=calls
    const accepted=await save(r,true)
    assert.equal(calls,beforeCalls);assert.equal(chapter().outline,r.outline);assert.equal(accepted.outline_revision,1)
    const state=await req(url);assert.equal(state.review,null);assert.equal(state.versions.length,1)
    const v=await req(`/chapters/1/outline-versions/${state.versions[0].id}`);assert.equal(v.outline,original)
    assert.equal(chapter().content,'原正文');assert.equal(chapter().status,'finalized');assert.equal(chapter().index_status,'ready')
    console.log('✓ 人工采纳零模型调用，原稿入历史，正文、定稿状态和索引不变')

    await req(`/chapters/1/outline-versions/${v.id}/restore`,'POST',{outline_revision:0},409)
    await req(`/chapters/1/outline-versions/${v.id}/restore`,'POST',{outline_revision:1})
    assert.equal(chapter().outline,original);assert.equal((await req(url)).versions.length,2)
    initSchema();assert.equal((await req(url)).versions.length,2)
    await req(`/chapters/2/outline-versions/${v.id}`,'GET',undefined,404)
    await req(url,'GET',undefined,404,outsider)
    console.log('✓ 原稿跨重新初始化可恢复，恢复前版本保留，跨章和越权访问拒绝')

    r=await generate()
    await edit('修改后的台本');await edit(original)
    assert.equal((await req(url)).review.stale,true)
    await save(r,true,409)
    const previous=(await req(url)).review
    const h=hold(),pending=generate(409);await h.reached;await edit('整理期间的新稿');h.release();await pending
    assert.equal(chapter().outline,'整理期间的新稿');assert.deepEqual((await req(url)).review,previous)
    console.log('✓ 台本改动再改回也使旧候选失效，迟到的模型结果不覆盖新稿或已有候选')

    r=await generate()
    const h2=hold(),pending2=generate(409);await h2.reached;r.outline+='\n另一窗口保存的补充';r=await save(r);h2.release();await pending2
    assert.equal((await req(url)).review.outline,r.outline)
    invalid=true;await generate(500);invalid=false
    assert.equal((await req(url)).review.outline,r.outline)
    await save({...r,outline:''},true,400)
    await save({...r,selected:[-1]},true,400)
    console.log('✓ 并发保存优先，异常模型输出与无效输入均保留已有候选和原稿')

    const before=chapter(),history=(await req(url)).versions
    db.exec("CREATE TRIGGER fail_outline_archive BEFORE INSERT ON chapter_outline_revisions BEGIN SELECT RAISE(ABORT,'模拟归档失败'); END")
    await save(r,true,400)
    assert.deepEqual(chapter(),before);assert.deepEqual((await req(url)).versions,history);assert((await req(url)).review)
    db.exec('DROP TRIGGER fail_outline_archive')
    r.selected=[0];r.outline+='\n'+r.suggestions[0].text;await save(r,true)
    assert(chapter().outline.includes('不揭示：幕后买家身份。'))
    console.log('✓ 采纳和归档原子提交，失败整体回滚；作者选中的建议随候选写入')

    compress=true;await generate()
    await req('/chapters/1','PUT',{outline:'过期输入',outline_revision:0},409)
    await req('/chapters/1','PUT',{outline:{}},400)
    console.log('✓ 可选对白压缩传给模型，手工编辑同样拒绝旧版本覆盖')
  }finally{globalThis.fetch=realFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
