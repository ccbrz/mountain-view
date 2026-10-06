/** 独立对话测试：验证模型范围、真实多轮消息、拒绝标记和失败不重试。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH=':memory:'
process.env.JWT_SECRET='chat-test-check-only'

async function main(){
  const {getDB}=await import('../db')
  const {initSchema}=await import('../schema')
  const {default:router}=await import('../routes/novel-generator')
  const db=getDB();initSchema()
  for(const name of ['chat-a','chat-b','embedding','unassigned'])db.prepare('INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES (?,?,?,?)').run(name,'https://chat-test.invalid',name,'test-only-secret')
  db.prepare('INSERT INTO novels(title,creator_username,llm_config,embedding_config) VALUES (?,?,?,?)').run('对话测试','author',JSON.stringify({architecture:'chat-a',chapter:'chat-a',consistency:'chat-b'}),'embedding')
  db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (1,'architecture','不能带入测试的小说设定')").run()
  const before=db.prepare('SELECT * FROM novels').all(),docs=db.prepare('SELECT * FROM novel_docs').all()
  const app=express();app.use(express.json());app.use('/novels',router)
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r))
  const realFetch=globalThis.fetch
  let calls=0,mode='json',sent:any
  globalThis.fetch=(async(url:any,options:any)=>{
    assert.equal(String(url),'https://chat-test.invalid/chat/completions');calls++
    sent=JSON.parse(options.body)
    assert.equal(options.headers.Authorization,'Bearer test-only-secret')
    if(mode==='fail')return new Response('upstream error test-only-secret',{status:503})
    if(mode==='sse')return new Response('data: {"choices":[{"delta":{"content":"连续"}}]}\n\ndata: {"choices":[{"delta":{"content":"回复"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n')
    if(mode==='filter')return Response.json({choices:[{message:{content:''},finish_reason:'content_filter'}]})
    if(mode==='refusal')return new Response('data: {"choices":[{"delta":{"refusal":"拒绝说明"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n')
    if(mode==='empty')return Response.json({choices:[{message:{content:''},finish_reason:'stop'}]})
    return Response.json({choices:[{message:{content:'你好'},finish_reason:'stop'}]})
  }) as typeof fetch
  const token=jwt.sign({username:'author',role:'user'},process.env.JWT_SECRET!)
  const req=async(method:string,body?:any,status=200,who=token)=>{
    const r=await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/1/chat-test`,{method,headers:{Authorization:`Bearer ${who}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})})
    const data:any=await r.json();assert.equal(r.status,status,JSON.stringify(data));return data
  }
  const input={config_name:'chat-a',messages:[{role:'user',content:'你好'}]}
  try{
    const models=await req('GET');assert.deepEqual(models.configs.map((c:any)=>c.name),['chat-a','chat-b'])
    assert(!JSON.stringify(models).includes('test-only-secret'));assert.equal(calls,0)
    await req('POST',{...input,config_name:'embedding'},400)
    await req('POST',{...input,config_name:'unassigned'},400)
    const outsider=jwt.sign({username:'other',role:'user'},process.env.JWT_SECRET!)
    await req('GET',undefined,404,outsider);await req('POST',input,404,outsider);assert.equal(calls,0)
    console.log('✓ 仅列出并允许项目对话模型，去重、排除独立 Embedding，权限与 Key 隔离')

    let r=await req('POST',input);assert.equal(r.content,'你好');assert.equal(r.finish_reason,'stop');assert.equal(calls,1)
    assert.deepEqual(sent.messages,input.messages);assert.equal(sent.model,'chat-a')
    mode='sse'
    const history=[...input.messages,{role:'assistant',content:'你好'},{role:'user',content:'继续'}]
    r=await req('POST',{config_name:'chat-b',messages:history,system_prompt:'简短回答'})
    assert.equal(r.content,'连续回复');assert.equal(sent.model,'chat-b')
    assert.deepEqual(sent.messages,[{role:'system',content:'简短回答'},...history]);assert.equal(calls,2)
    assert(!JSON.stringify(sent).includes('不能带入测试的小说设定'))
    console.log('✓ JSON 和 SSE 均可回复，多轮角色与可选系统提示原样传递，不注入小说上下文')

    for(const body of [
      {...input,messages:[]},{...input,messages:[{role:'system',content:'越权角色'}]},
      {...input,messages:[{role:'user',content:' '}]},{...input,messages:[{role:'user',content:'x'.repeat(8001)}]},
      {...input,messages:[...input.messages,...input.messages]},
      {...input,system_prompt:'x'.repeat(2001)},
      {...input,messages:Array.from({length:19},(_,i)=>({role:i%2?'assistant':'user',content:'x'.repeat(900)}))},
    ])await req('POST',body,400)
    assert.equal(calls,2)
    console.log('✓ 拒绝无效角色、空消息、顺序错误和过长会话，不调用上游')

    mode='filter';r=await req('POST',input);assert.equal(r.finish_reason,'content_filter');assert.equal(r.content,'')
    mode='refusal';r=await req('POST',input);assert.equal(r.refusal,'拒绝说明')
    mode='fail';const count=calls;r=await req('POST',input,502);assert.equal(calls,count+1);assert(!r.message.includes('test-only-secret'));assert.match(r.message,/503/)
    mode='empty';const emptyCount=calls;await req('POST',input,502);assert.equal(calls,emptyCount+1)
    assert.deepEqual(db.prepare('SELECT * FROM novels').all(),before);assert.deepEqual(db.prepare('SELECT * FROM novel_docs').all(),docs)
    console.log('✓ 内容过滤和拒绝元数据保留，错误单次即返回且脱敏，不修改小说数据')

    db.prepare("UPDATE novels SET llm_config='chat-a' WHERE id=1").run()
    assert.deepEqual((await req('GET')).configs.map((c:any)=>c.name),['chat-a'])
    console.log('✓ 兼容旧版单模型项目配置')
  }finally{globalThis.fetch=realFetch;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));db.close()}
}
main().catch(e=>{console.error(e);process.exitCode=1})
