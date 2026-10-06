/** 架构请求失败立即停止，不重试、不提交半成品；不访问业务数据库或真实模型。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'architecture-check-only'

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initLogStore } = await import('../llm/logstore')
  const { initVectorStore } = await import('../llm/vectorstore')
  const { default: router } = await import('../routes/novel-generator')
  const db = getDB(); initSchema(); initLogStore(); initVectorStore()
  db.prepare("INSERT INTO llm_configs(name,base_url,model_name) VALUES ('mock','https://architecture-test.invalid','mock')").run()
  db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('测试小说','author','mock')").run()
  for (const type of ['architecture','characters']) db.prepare('INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (1,?,?)').run(type,`原有${type}`)
  db.prepare("INSERT INTO novel_chapters(novel_id,chapter_number,content,status) VALUES (1,1,'原有正文','finalized')").run()
  const app = express(); app.use(express.json()); app.use('/novels',router)
  const server = app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r))
  const realFetch = globalThis.fetch
  let failAt = 0, calls = 0
  globalThis.fetch = (async (url: any) => {
    assert(String(url).startsWith('https://architecture-test.invalid/'))
    calls++
    if(calls === failAt) {
      if(failAt === 1) return new Response('模拟上游不可用',{status:503})
      if(failAt === 2) return Response.json({choices:[{message:{content:''}}]})
      throw new DOMException('模拟请求超时','AbortError')
    }
    return Response.json({choices:[{message:{content:`第${calls}步结果`}}]})
  }) as typeof fetch
  const request = () => realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/1/generate/architecture`, {
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${jwt.sign({username:'author',role:'user'},process.env.JWT_SECRET!)}`},body:'{}',
  })
  const snapshot = () => ['novels','novel_docs','novel_chapters'].map(table=>db.prepare(`SELECT * FROM ${table}`).all())
  try {
    const before = snapshot()
    for(const [i,label] of ['核心种子生成','角色档案生成','世界观生成'].entries()) {
      failAt = i+1; calls = 0
      const response = await request(), data: any = await response.json()
      assert.equal(response.status,500); assert.equal(calls,failAt,'失败步骤不可重试或继续后续步骤')
      assert(data.message.includes(`${label}失败`)); assert(data.message.includes('未自动重试'))
      assert.deepEqual(snapshot(),before,'失败不得写入半成品或影响正文')
      console.log(`✓ ${label}失败即停止，标明阶段，已有内容不变`)
    }
    failAt = 0; calls = 0
    const response = await request(), data: any = await response.json()
    assert.equal(response.status,200,JSON.stringify(data)); assert.equal(calls,3); assert.equal(data.results.length,3)
    assert.match((db.prepare("SELECT content FROM novel_docs WHERE doc_type='architecture'").get() as any).content,/第3步结果/)
    assert.equal((db.prepare('SELECT content FROM novel_chapters WHERE id=1').get() as any).content,'原有正文')
    console.log('✓ 成功时三步各调用一次，完整保存架构和角色，正文保留')
  } finally {
    globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); db.close()
  }
}
main().catch(e=>{console.error(e);process.exitCode=1})
