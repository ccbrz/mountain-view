/** 离线回归；加 --live 时用原20章证据和真实模型复测（业务库只读）。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import Database from 'better-sqlite3'
import express from 'express'
import jwt from 'jsonwebtoken'

process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'memory-repair-check-only'
const root = path.resolve(__dirname, '../../..')
const baseline = path.join(root, 'demo-output/memory-20-2026-10-06T01-53-54-734Z')

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { initVectorStore, PersistentVectorStore } = await import('../llm/vectorstore')
  const { initLogStore } = await import('../llm/logstore')
  const { embed } = await import('../llm/embedding')
  const { invokeLLM } = await import('../llm/adapter')
  const { searchChapterText, chapterEvidence } = await import('../llm/chapter-evidence')
  const { applyDelta, updateProgress, renderProgress } = await import('../llm/progress')
  const { checkContinuity } = await import('../llm/continuity')
  const { saveProgressSnapshot } = await import('../llm/doc-snapshots')
  const { parseReviewJSON } = await import('../llm/review')
  const db = getDB(); initSchema(); initVectorStore(); initLogStore()
  const config = { id: 1, name: 'test', interface_format: 'OpenAI', base_url: '', api_key: '', model_name: 'test', temperature: 0, max_tokens: 100, timeout: .05 }
  const slow = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders() })
  await new Promise<void>(r => slow.listen(0, '127.0.0.1', r))
  config.base_url = `http://127.0.0.1:${(slow.address() as any).port}`
  for (const run of [() => embed(config, '测试'), () => invokeLLM(config, '', '测试')]) {
    const start = Date.now(); await assert.rejects(run, /超时/); assert(Date.now() - start < 1000)
  }
  slow.closeAllConnections(); await new Promise<void>(r => slow.close(() => r()))
  console.log('✓ 向量/对话接口响应头已到、响应体挂起，均按时中止')
  const realFetch = globalThis.fetch
  try {
    for (const vector of [undefined, [], ['bad'], [0, 0], [null]]) {
      globalThis.fetch = (async () => Response.json({ data: [{ embedding: vector }] })) as typeof fetch
      await assert.rejects(() => embed(config, 'x'), /有效/)
    }
    globalThis.fetch = (async () => Response.json({ data: [{ embedding: [1, 2] }] })) as typeof fetch
    assert.deepEqual(await embed(config, 'x'), [1, 2])
  } finally { globalThis.fetch = realFetch }
  console.log('✓ 无效向量拒绝，合法向量接受')
  try {
    globalThis.fetch = (async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }) }) as typeof fetch
    for (const run of [() => embed(config, '测试'), () => invokeLLM(config, '', '测试')]) await assert.rejects(run, /无法解析服务域名.*ENOTFOUND/)
  } finally { globalThis.fetch = realFetch }
  console.log('✓ DNS 故障与请求超时明确区分')
  try {
    let candidateId = 'C1'
    globalThis.fetch = (async () => Response.json({ choices: [{ message: { content: JSON.stringify({ issues: [{ problem: '有证据的矛盾', candidate_id: candidateId, evidence_id: 'S1' }] }) } }] })) as typeof fetch
    const issues = await checkContinuity(config, '原始依据，不能被模型改写。', '原始正文，保留原句。', {novel_id:1,task:'citation-check'})
    assert.equal(issues[0].quote,'原始正文，保留原句。'); assert.equal(issues[0].evidence,'原始依据，不能被模型改写。')
    candidateId = 'C999'
    await assert.rejects(() => checkContinuity(config,'依据','正文',{novel_id:1,task:'invalid-citation'}),/不存在的原文编号/)
  } finally { globalThis.fetch = realFetch }
  console.log('✓ 引文由编号提取原文，伪造编号拒绝提交')

  try {
    let extractionCalls = 0
    const bad = JSON.stringify({summary:'季叔拿到钥匙',handoff:{scene:'码头'},facts:[{op:'set',kind:'item',subject:'钥匙',predicate:'持有人',value:'钥匙'}],hooks:[]})
    globalThis.fetch = (async (_url: any, options: any) => {
      const body = JSON.parse(options.body)
      let content = '{"issues":[]}'
      if(body.messages[0].content.startsWith('你是小说的连载编辑')) {
        extractionCalls++; assert.equal(body.temperature,0)
        if(extractionCalls===1) content=bad
        else { assert(body.messages[1].content.includes(bad)); content=bad.replace('"value":"钥匙"','"value":"季叔"') }
      }
      return Response.json({choices:[{message:{content}}]})
    }) as typeof fetch
    const corrected = await updateProgress(config,null,1,'季叔拿着钥匙。',{novel_id:1,task:'retry-check'})
    assert.equal(extractionCalls,2); assert.equal(corrected.facts[0].value,'季叔')
  } finally { globalThis.fetch=realFetch }
  console.log('✓ 事实提取低温度；校验重试携带上一版完整JSON并修正错误')
  const prev: any = { chapter: 1, summaries: [], facts: [{ id: 'F1', kind: 'item', subject: '铜钥匙', predicate: '持有人', value: '季叔' }],
    hooks: [{ id: 'H1', content: '账本是否在井里，谁藏的？', planted: 1, lastAdvanced: null, status: 'open' }], handoff: {}, nextFact: 2, nextHook: 2 }
  const delta = { summary: '顾澜取出账本。', handoff: { scene: '井边' }, facts: [], hooks: [] }
  assert.throws(() => applyDelta(prev, { ...delta, facts: [{ op: 'set', id: 'H1', value: '顾澜' }] }, 2), /找不到编号/)
  assert.throws(() => applyDelta(prev, { ...delta, hooks: [{ op: 'advance', id: 'F1' }] }, 2), /找不到编号/)
  assert.throws(() => applyDelta(prev, { ...delta, facts: [{ op: 'set', id: 'F1', value: '铜钥匙' }] }, 2), /不能重复/)
  const updated = applyDelta(prev, { ...delta, facts: [{ op: 'set', id: 'F1', value: '顾澜' }], hooks: [{ op: 'advance', id: 'H1', content: '谁把账本藏进井里？' }] }, 2)
  assert.equal(updated.facts[0].id, 'F1'); assert.equal(updated.hooks[0].content, '谁把账本藏进井里？'); assert.equal(prev.facts[0].value, '季叔')
  const review = parseReviewJSON(JSON.stringify({ scores: { consistency: 15, webnovel: 20 }, issues: [{ severity: '必改', dimension: '设定一致性', problem: '越权知情' }] }))
  assert.equal(review.total, 100); assert.equal(review.verdict, 'revise')
  const secretState = { ...prev, facts: [...prev.facts, { id: 'F2', kind: 'situation', subject: '沈砚', predicate: '位置', value: '码头' }, { id: 'F3', kind: 'knowledge', subject: '闻舟的证件被刮改', predicate: '知情', value: '闻舟本人；读者已知' }] }
  assert.match(renderProgress(secretState), /尚未获知：沈砚/)
  console.log('✓ 事实/伏笔编号隔离、自持有拒绝、伏笔部分解决、必改项阻断高分通过')
  const id = Number(db.prepare("INSERT INTO novels(title,creator_username) VALUES ('测试','test')").run().lastInsertRowid)
  const insert = db.prepare('INSERT INTO novel_chapters(novel_id,chapter_number,content,status) VALUES (?,?,?,?)')
  insert.run(id, 2, '黑陶碗下面有七枚白石，用来数七张修好的渔网。', 'finalized')
  insert.run(id, 19, '黑陶碗下面是瓦片。', 'finalized')
  insert.run(id, 3, '黑陶碗下面是草稿污染。', 'draft')
  const other = Number(db.prepare("INSERT INTO novels(title,creator_username) VALUES ('其他','test')").run().lastInsertRowid)
  insert.run(other, 1, '黑陶碗下面是别书污染。', 'finalized')
  assert.deepEqual(searchChapterText(id, 19, '黑陶碗').map(e => e.chapter), [2])
  db.prepare('UPDATE novel_chapters SET content=? WHERE novel_id=? AND chapter_number=2').run('黑陶碗下面是作者修订过的原文。', id)
  assert.match(searchChapterText(id, 19, '黑陶碗')[0].text, /修订过/)
  db.prepare('INSERT INTO llm_configs(name,base_url,model_name,timeout) VALUES (?,?,?,?)').run('test-vector','https://test.invalid','v1',1)
  const store = new PersistentVectorStore(id); store.setEmbeddingConfig('test-vector')
  try {
    globalThis.fetch = (async () => Response.json({ data: [{ embedding: [1,2] }] })) as typeof fetch
    await store.insert('黑陶碗的向量片段', {chapter:2})
    assert.equal((await store.search('黑陶碗')).length,1)
    db.prepare("UPDATE llm_configs SET model_name='v2' WHERE name='test-vector'").run()
    assert.equal((await store.search('黑陶碗')).length,0, '同维度不同模型不得混用索引')
    db.prepare("UPDATE llm_configs SET model_name='v1' WHERE name='test-vector'").run()
    globalThis.fetch = (async () => { throw new Error('模拟向量服务故障') }) as typeof fetch
    const fallback = await chapterEvidence({id,embedding_config:'test-vector'},19,'黑陶碗')
    assert.match(fallback.text,/修订过/); assert.match(fallback.warning,/已使用本地原文/)
    db.prepare("UPDATE novel_chapters SET status='draft' WHERE novel_id=? AND chapter_number=2").run(id)
    assert.equal((await store.search('黑陶碗')).length,0, '残留向量不能暴露未定稿正文')
  } finally { globalThis.fetch = realFetch }
  console.log('✓ 向量空间隔离、服务故障原文兜底、残留向量的定稿边界')
  db.prepare('DELETE FROM novel_chapters WHERE novel_id=? AND chapter_number=2').run(id)
  assert.equal(searchChapterText(id, 19, '黑陶碗').length, 0)
  console.log('✓ 全文检索过滤其他小说、未来章和草稿，修改/删除同步更新')

  if (!process.argv.includes('--live')) { db.close(); return }
  const out = path.join(root, `demo-output/memory-repair-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(out, { recursive: true }); console.log(`真实复测输出：${out}`)
  const source = new Database(path.join(root, 'data/app.db'), { readonly: true })
  const configs = source.prepare('SELECT * FROM llm_configs').all() as any[]
  const novelConfig = source.prepare('SELECT llm_config, embedding_config FROM novels WHERE id=1').get() as any
  source.close()
  for (const c of configs) db.prepare('INSERT INTO llm_configs(name,base_url,model_name,api_key,temperature,max_tokens,timeout) VALUES (?,?,?,?,?,?,?)').run(c.name,c.base_url,c.model_name,c.api_key,c.temperature,c.max_tokens,c.timeout)
  const map = JSON.parse(novelConfig.llm_config)
  const llm = { ...configs.find(c => c.name === map.consistency)! }
  const modelOverride = process.argv.find(arg => arg.startsWith('--model='))?.slice('--model='.length)
  if (modelOverride) {
    assert(process.argv.some(arg => /^--(?:detect-only=|state-only=|controls-only$)/.test(arg)), '--model 仅用于 detect-only、state-only 或 controls-only 的隔离对照')
    llm.model_name = modelOverride // 仅本次隔离评估，不修改业务配置。
  }
  const embedding = configs.find(c => c.name === novelConfig.embedding_config)!
  const safe = (v: unknown) => configs.reduce((s,c) => c.api_key ? s.split(c.api_key).join('[REDACTED]') : s, JSON.stringify(v,null,2))
  const write = (name: string, v: unknown) => fs.writeFileSync(path.join(out,name),safe(v))
  const chapter = (n: number) => JSON.parse(fs.readFileSync(path.join(baseline,`ch${String(n).padStart(2,'0')}.json`),'utf8'))
  const manifest = JSON.parse(fs.readFileSync(path.join(baseline,'manifest.json'),'utf8'))
  const results: any = { baseline: path.basename(baseline), model: llm.model_name, args: process.argv.slice(2) }
  const failures: string[] = []
  const novelId = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config,embedding_config,word_number) VALUES ('复测','test',?,'',2000)").run(novelConfig.llm_config).lastInsertRowid)
  for (const [type, content] of [['architecture',manifest.architecture],['characters',manifest.characters]]) db.prepare('INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,?,?)').run(novelId,type,content)
  for (let n=1;n<=18;n++) {
    const ch = chapter(n)
    db.prepare("INSERT INTO novel_chapters(novel_id,chapter_number,title,outline,content,status,word_count) VALUES (?,?,?,?,?,'finalized',?)").run(novelId,n,ch.title,ch.outline,ch.content,ch.wordCount)
    saveProgressSnapshot(db,novelId,n+1,ch.state)
  }
  const novel = db.prepare('SELECT * FROM novels WHERE id=?').get(novelId) as any
  const saveLogs = () => write('calls.json',db.prepare('SELECT task,model_name,system_prompt,user_prompt,response,status,error FROM llm_call_logs WHERE novel_id=? ORDER BY rowid').all(novelId))
  const logTimer = setInterval(saveLogs,5000)
  try {
    const start = Date.now(); const vec = await embed(embedding,'七枚白石代表修好的七张渔网')
    results.embedding = { model: embedding.model_name, dimensions: vec.length, ms: Date.now()-start }
    console.log('✓ 真向量接口',JSON.stringify(results.embedding))
    const evidence = await chapterEvidence(novel,19,chapter(19).outline)
    write('retrieval-19.json',evidence)
    assert.match(evidence.text,/七粒/); assert.match(evidence.text,/七张网/)
    results.lexicalRecall = true; console.log('✓ 关闭向量也能找到第2章的白石/渔网原文')
    if (process.argv.includes('--controls-only')) {
      results.controls = await Promise.all([
        { name: '当场披露允许', source: '- 旧图藏在闻舟包里｜知情：闻舟；尚未获知：沈砚', candidate: '闻舟打开自己的布包，把旧图展给沈砚看。沈砚这才知道旧图一直在他包里。' },
        { name: '放桌上仍由原人保管', source: '沈砚持有铜钥匙。他将钥匙暂放桌上，仍由他负责保管。', candidate: '- 铜钥匙｜持有人：沈砚\n- 铜钥匙｜位置：桌上', state: true },
        { name: '缺少描写不等于反证', source: '那天季叔抽了两口烟，给沈砚一碗水。', candidate: '沈砚想起那天季叔烧过水，还抽了两口烟。' },
      ].map(async c => ({ name: c.name, issues: await checkContinuity(llm,c.source,c.candidate,{novel_id:novelId,task:`control:${c.name}`},c.state) })))
      write('controls.json',results.controls)
      assert(results.controls.every((c: any) => c.issues.length === 0),'正常发展被误报，见 controls.json')
      console.log('✓ 3个反例：当场披露、保管人与位置区分、未描写细节均未误报')
      return
    }
    const stateOnly = process.argv.find(arg => arg.startsWith('--state-only='))?.split('=')[1]
    const apiOnly = process.argv.includes('--api-only')
    if(stateOnly) assert(['4','16'].includes(stateOnly),'--state-only 仅支持已知案例 4 或 16')
    const detectOnly = process.argv.find(arg => arg.startsWith('--detect-only='))?.split('=')[1]
    if (detectOnly) assert(['6','19'].includes(detectOnly),'--detect-only 仅支持已知案例 6 或 19')
    const cases = await Promise.allSettled((apiOnly || stateOnly ? [] : detectOnly ? [Number(detectOnly)] : [6,19]).map(async n => {
      const history = await chapterEvidence(novel,n,chapter(n).outline)
      const context = manifest.characters + '\n' + renderProgress(chapter(n-1).state,3) + history.text
      const issues = await checkContinuity(llm,context,chapter(n).content,{novel_id:novelId,task:`repair:detect:${n}`})
      write(`detected-${n}.json`,{context,issues}); assert(n===6 ? issues.some(i=>/知情|尚未|不知道|未知/.test(i.problem)&&/证件|草图|旧图/.test(i.quote+' '+i.evidence)) : issues.some(i=>/碎瓦|瓦片/.test(i.quote)&&/白石/.test(i.evidence)),`第${n}章应检出指定的已知问题，而不是任意其他问题`)
      console.log(`✓ 检出第${n}章连续性错误：${issues.length}项（引文已保存）`)
      return { chapter:n,issues }
    }))
    results.detection=cases.map(r=>r.status==='fulfilled'?r.value:{error:String(r.reason)})
    write('detection-results.json',results.detection)
    for(const r of cases) if(r.status==='rejected') failures.push(String(r.reason))
    if(detectOnly) { assert.equal(failures.length,0,failures.join('；')); return }
    await Promise.all((apiOnly ? [] : stateOnly ? [Number(stateOnly)] : [4,16]).map(async n => {
      console.log(`重新提取第${n}章状态`)
      try {
      const next=await updateProgress(llm,chapter(n-1).state,n,chapter(n).content,{novel_id:novelId,task:`repair:state:${n}`})
      write(`state-${n}.json`,next)
      assert(!next.facts.some(f=>f.predicate==='持有人'&&f.subject===f.value))
      if(n===16) assert(!next.hooks.some(h=>h.id==='H7'),'已查明换册者及动机，不应保留H7')
      results[`state${n}`]=true; console.log(`✓ 第${n}章记忆重新提取通过`)
      } catch(e: any) { results[`state${n}`]={error:e.message}; failures.push(e.message); console.log(`第${n}章状态失败：${e.message}`) }
    }))
    if(stateOnly) { assert.equal(failures.length,0,failures.join('；')); return }
    const vs=new PersistentVectorStore(novelId);vs.setEmbeddingConfig(embedding.name)
    vs.replaceChapter(2,await vs.prepareChapter(chapter(2).content))
    const semantic=await vs.search('黑陶碗下的小东西用来计数什么',3,m=>Number(m.chapter)<19)
    write('semantic-2.json',semantic);assert(semantic.some(e=>e.text.includes('白石')))
    results.semanticRecall=true;console.log('✓ 真向量建索引及语义召回命中原始细节')
    const {default:generator}=await import('../routes/novel-generator')
    const app=express();app.use(express.json());app.use('/novels',generator)
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r))
    const token=jwt.sign({username:'test',role:'admin'},process.env.JWT_SECRET!)
    const request=async(route:string)=>{
      const r=await fetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novelId}${route}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'})
      const body:any=await r.json();return {status:r.status,body}
    }
    try {
      const ch=chapter(19);db.prepare("INSERT INTO novel_chapters(novel_id,chapter_number,title,outline,content) VALUES (?,?,?,?,?)").run(novelId,19,ch.title,ch.outline,ch.content)
      const revision=(db.prepare('SELECT context_revision FROM novels WHERE id=?').get(novelId) as any).context_revision
      const blocked=await request('/generate/finalize/19');write('blocked-finalize-19.json',blocked)
      assert.equal(blocked.status,422);assert.equal((db.prepare('SELECT context_revision FROM novels WHERE id=?').get(novelId) as any).context_revision,revision)
      assert.equal(db.prepare('SELECT 1 FROM novel_doc_snapshots WHERE novel_id=? AND chapter_number=20').get(novelId),undefined)
      results.atomicBlock=true;console.log('✓ 错误回忆定稿被阻止，快照/版本未污染')
      const drafted=await request('/generate/chapter/19');write('draft-result-19.json',drafted);assert.equal(drafted.status,200)
      const content=(db.prepare('SELECT content FROM novel_chapters WHERE novel_id=? AND chapter_number=19').get(novelId) as any).content
      fs.writeFileSync(path.join(out,'repaired-ch19.md'),content)
      assert.match(content,/白石/);assert.match(content,/补.{0,12}网/);assert.doesNotMatch(content,/瓦片/)
      assert.doesNotMatch(content,/数量.{0,8}(?:记不清|记不得|忘了)/,'已有原文给出历史数量，不能以记不清回避台本要求')
      results.draft19=true;console.log('✓ 第19章起草接口及白石/渔网细节检查通过，全文仍需审阅')
    } finally {server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()))}
  } catch (e: any) {
    results.fatal = e.message
    throw e
  } finally {
    clearInterval(logTimer)
    write('results.json',{...results,failures})
    write('calls.json',db.prepare('SELECT task,model_name,system_prompt,user_prompt,response,status,error FROM llm_call_logs WHERE novel_id=? ORDER BY rowid').all(novelId))
    db.close()
  }
  assert.equal(failures.length,0,failures.join('；'))
}
main().catch(e=>{console.error(e.message);process.exitCode=1})
