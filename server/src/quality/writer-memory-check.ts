/** Finalize several chapters → restore a prior Memory → rewrite → rebuild valid snapshots. */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'memory-versions-test-only'

async function main() {
  const {getDB} = await import('../db'), {initSchema} = await import('../schema'), {initLogStore} = await import('../llm/logstore'), {initVectorStore} = await import('../llm/vectorstore')
  const {default: writer} = await import('../routes/writer')
  const db = getDB(); initSchema(); initLogStore(); initVectorStore()
  const model = Number(db.prepare("INSERT INTO llm_configs(name,base_url,model_name) VALUES ('mock','https://memory.invalid/v1','mock')").run().lastInsertRowid)
  const id = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('记忆版本测试','author','mock')").run().lastInsertRowid)
  for (let n = 1; n <= 3; n++) db.prepare('INSERT INTO novel_chapters(novel_id,chapter_number,title,content,outline) VALUES (?,?,?,?,?)').run(id,n,`第${n}章`,`第${n}章原正文。`,`第${n}章台本。`)
  const app = express(); app.use(express.json()); app.use('/novels',writer)
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r))
  const realFetch = fetch, token = jwt.sign({username:'author',role:'user'},process.env.JWT_SECRET!)
  let calls = 0
  globalThis.fetch = (async () => {calls++; return Response.json({choices:[{message:{content:'第二章的新正文。'},finish_reason:'stop'}]})}) as typeof fetch
  const req = async (path: string, body?: any, status=200, auth=token) => {
    const response = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${id}/writer${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${auth}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})})
    const data:any=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data
  }
  const count = () => (db.prepare('SELECT count(*) AS n FROM writer_memory_history WHERE novel_id=?').get(id) as any).n
  try {
    let settings = (await req('/project')).settings
    settings = (await req('/settings',{base_settings:settings,settings:{...settings,memory:'开篇前背景。',model_id:String(model),context_tokens:100000}})).settings
    for (let n=1;n<=3;n++) settings=(await req(`/chapter/${n}/finalize`,{confirmed:true,base_settings:settings,base_chapter:await req(`/chapter/${n}`),memory:`截至${n}章的完整记忆。`})).settings
    assert.equal(settings.memory_through_chapter,3)
    const preview = await req('/memory/before/2')
    assert(preview.restorable);assert.equal(preview.memory,'截至1章的完整记忆。')
    assert.equal((await req('/project')).settings.memory,settings.memory)
    const restore = {version_id:preview.id,target_chapter:2,context_revision:preview.context_revision,base_settings:settings,settings}
    const originalCount=count()
    db.exec("CREATE TRIGGER fail_restore BEFORE INSERT ON writer_memory_history WHEN NEW.kind='restore' BEGIN SELECT RAISE(ABORT,'模拟恢复写入失败'); END")
    await req('/memory/restore',restore,400); assert.equal(count(),originalCount);assert.equal((await req('/project')).settings.memory,settings.memory)
    db.exec('DROP TRIGGER fail_restore')
    settings=(await req('/memory/restore',restore)).settings
    assert.equal(settings.memory_through_chapter,1);assert.equal(settings.memory,preview.memory)
    assert.equal((await req('/chapter/3')).content,'第3章原正文。')
    assert((await req('/memory/history')).items.some((v:any)=>v.kind==='backup'&&v.memory_through_chapter===3&&v.restorable))
    assert.equal(calls,0)
    console.log('✓ 已定稿旧章可预览并恢复章前完整记忆，当前版本备份，恢复不改正文；失败事务整体回滚')

    const base = await req('/chapter/2'), source={...base,chapter_idx:2,mode:'write',settings}
    const generated=await req('/generate',source);assert.equal(calls,1)
    await req('/save',{...source,content:generated.content,base_chapter:base,last_context:generated.context})
    assert.equal((await req('/chapter/3')).status,'needs_review')
    assert.equal((await req('/chapter/3')).content,'第3章原正文。')
    assert(!(await req('/memory/before/3')).restorable)
    assert((await req('/memory/before/2')).restorable)
    await req('/memory/restore',restore,409)
    settings=(await req('/chapter/2/finalize',{confirmed:true,base_settings:settings,base_chapter:await req('/chapter/2'),memory:'第二章改写后的完整记忆。'})).settings
    assert.equal((await req('/memory/before/3')).memory,'第二章改写后的完整记忆。')
    const history=(await req('/memory/history')).items
    const old=history.find((v:any)=>v.kind==='finalize'&&v.memory_through_chapter===3)
    assert(!old.restorable);assert(old.invalidated_at)
    const oldFull=await req(`/memory/history/${old.id}`)
    assert.equal(oldFull.memory,'截至3章的完整记忆。')
    await req('/memory/restore',{version_id:old.id,context_revision:oldFull.context_revision,settings,base_settings:settings},400)
    console.log('✓ 改写使后续快照失效但不删除；重定稿产生新快照；过期请求和旧后文记忆不能恢复')

    const valid=await req('/memory/before/2')
    db.prepare("UPDATE novel_chapters SET content='绕过界面修改的前文' WHERE novel_id=? AND chapter_number=1").run(id)
    assert(!(await req(`/memory/history/${valid.id}`)).restorable,'Digest catches changes even without invalidation metadata')
    await req('/memory/before/2',undefined,404,jwt.sign({username:'other',role:'user'},process.env.JWT_SECRET!))
    db.prepare('DELETE FROM writer_memory_history WHERE novel_id=? AND memory_through_chapter=0').run(id)
    const empty=await req('/memory/before/1');assert(empty.empty_opening);assert.equal(empty.memory,'')
    console.log('✓ 来源正文变更可核验，权限不旁路；缺少开篇快照时只提供明确的空记忆选项')
  } finally {globalThis.fetch=realFetch;await new Promise<void>(r=>server.close(()=>r()));db.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
