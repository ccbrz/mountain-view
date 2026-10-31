/** Writing desk regression: isolated SQLite, authenticated HTTP and simulated providers. */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'writer-regression-test-only'

async function main() {
  const { getDB } = await import('../db'), { initSchema } = await import('../schema')
  const { initVectorStore } = await import('../llm/vectorstore'), { initLogStore } = await import('../llm/logstore')
  const { default: writer } = await import('../routes/writer'), { default: legacy } = await import('../routes/novel-generator')
  const db = getDB(); initSchema(); initVectorStore(); initLogStore()
  const model = Number(db.prepare("INSERT INTO llm_configs(name,base_url,model_name,api_key) VALUES ('existing','https://writer-test.invalid/v1','existing-model','test-only-secret')").run().lastInsertRowid)
  const novel = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config,style_guide,style_reference) VALUES ('原有作品','author','existing','短句，少旁白','这是已有范文。')").run().lastInsertRowid)
  db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'architecture','原有世界观')").run(novel)
  db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'characters','## 林舟\n身份：工程师\n\n## 老赵\n身份：船长')").run(novel)
  for (const [num, body] of [[1, '第一章结尾🛰️'], [3, '目标章原正文'], [10, '未来正文不能注入']] as const) db.prepare('INSERT INTO novel_chapters(novel_id,chapter_number,title,outline,content) VALUES (?,?,?,?,?)').run(novel, num, `第${num}章`, '林舟找到老赵', body)
  const app = express(); app.use(express.json({ limit: '4mb' })); app.use('/novels', legacy); app.use('/novels', writer)
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r))
  const realFetch = globalThis.fetch, token = jwt.sign({ id: 1, username: 'author', role: 'user' }, process.env.JWT_SECRET!), other = jwt.sign({ username: 'other', role: 'user' }, process.env.JWT_SECRET!)
  const req = async (url: string, method = 'GET', body?: any, expected = 200, auth = token) => {
    const response = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}${url}`, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value: any = await response.json(); assert.equal(response.status, expected, JSON.stringify(value)); return value
  }
  const sentPrompts: any[] = []
  let modelFailure = false, finishReason = 'stop', sse = false, expectedModel = 'existing-model'
  let calls = 0, sent: any, output = '新的正文', release: (() => void) | undefined, reached: (() => void) | undefined, held: Promise<void> | undefined
  globalThis.fetch = (async (url: any, options: any) => {
    assert.equal(String(url), 'https://writer-test.invalid/v1/chat/completions'); calls++; sent = JSON.parse(options.body); sentPrompts.push(sent)
    assert.equal(sent.model, expectedModel)
    if (modelFailure) throw new Error('模拟整理记忆失败')
    if (held) { reached?.(); await held }
    const content = sent.messages[0].content.startsWith('你是小说连续性核验员') ? '{"issues":[]}' : output
    if (sse) return new Response(`data: ${JSON.stringify({choices:[{delta:{content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:finishReason}]})}\n\ndata: [DONE]\n\n`)
    return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] })
  }) as typeof fetch
  const row = () => db.prepare('SELECT * FROM novel_chapters WHERE novel_id=? AND chapter_number=3').get(novel) as any
  try {
    const project = await req('/writer/project'), models = await req('/writer/models')
    assert.equal(project.settings.model_id, String(model)); assert.equal(models.models.length, 1); assert(!JSON.stringify(models).includes('test-only-secret'))
    assert.equal(project.settings.lorebook.length, 3)
    assert.equal(project.settings.system_prompt, project.writing_template) // Editable prefilled default.
    assert(project.writing_template.includes('通用创作与去 AI 味'))
    assert.equal(project.chapters.find((c:any)=>c.chapter_idx===3).id,row().id)
    assert.equal((await req('/writer/chapter/3')).id,row().id)
    assert(project.chapters.every((c:any)=>!('content' in c) && typeof c.status==='string'))
    db.prepare("INSERT INTO novel_chapter_summaries(novel_id,chapter_number,content) VALUES (?,1,'旧版N章差分摘要不应进入请求')").run(novel)
    db.prepare("INSERT INTO novel_doc_snapshots(novel_id,chapter_number,doc_type,content) VALUES (?,2,'progress','旧版逐章记忆不应进入请求')").run(novel)
    db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'progress','旧版全局进度不应盖过Memory')").run(novel)
    const input = { chapter_idx: 3, raw_script: '林舟找老赵借船', title: '借船', author_note: '只写到答应借船', content: '目标章原正文', settings: project.settings, mode: 'write' }
    input.settings.recent_context_chars = 6
    input.settings.lorebook.push({ id: 'off', title: '禁用', text: '禁用信息', keys: [], enabled: false, always_on: true, category: '' })
    const preview = await req('/writer/context', 'POST', input)
    assert.deepEqual(preview.recent_sources, [1]); assert(!preview.user_prompt.includes('未来正文')); assert(!preview.user_prompt.includes('禁用信息'))
    assert(!preview.user_prompt.includes('旧版N章差分摘要')); assert(!preview.user_prompt.includes('旧版逐章记忆')); assert(!preview.user_prompt.includes('旧版全局进度'))
    assert(preview.system_prompt.includes('短句，少旁白')); assert(preview.system_prompt.includes('去 AI 味')); assert(preview.user_prompt.includes('这是已有范文'))
    assert(preview.system_prompt.includes(project.writing_template))
    assert.equal(preview.system_prompt.split('【默认文笔建议】').length, 2)
    assert(preview.system_prompt.includes('本书文风指南与范文参考 > 模板中保留的默认文笔建议'))
    assert.deepEqual(preview.blocks.slice(-2).map((b:any)=>b.label),['作者批注','本次任务'])
    assert(preview.budget.estimated_input_tokens + preview.budget.output_tokens + preview.budget.reserved_tokens <= preview.budget.context_tokens)
    assert(!project.writing_template.includes('全章不超过 3 处')); assert(!project.writing_template.includes('禁用词：'))
    const {buildWriterContext} = await import('../llm/writer-context')
    const novelRow = db.prepare('SELECT * FROM novels WHERE id=?').get(novel) as any
    const { chapterLengthRange } = await import('../llm/prompts')
    assert.deepEqual(project.length_range, chapterLengthRange(novelRow.word_number || 2000))
    const lengthNovel = {...novelRow, word_number: 4000}
    const lengthContext = buildWriterContext(db, lengthNovel, input, 'write')
    assert(lengthContext.system_prompt.includes('目标 4000–5000 字'))
    assert(lengthContext.blocks.at(-1)?.text.includes('目标 4000–5000 字'))
    const lengthContinue = buildWriterContext(db, lengthNovel, {...input, content: '甲 乙\n🛰'}, 'continue')
    assert(lengthContinue.blocks.at(-1)?.text.includes('当前正文已有 3 字'))
    assert(lengthContinue.blocks.at(-1)?.text.includes('已有正文与本次新增正文的合计'))
    const lengthRevise = buildWriterContext(db, lengthNovel, {...input, selected:'甲',before:'',after:''}, 'revise')
    assert(!lengthRevise.user_prompt.includes('4000–5000'))
    assert(!lengthRevise.system_prompt.includes('4000–5000'))

    const triggerLore = {id:'note-lore',title:'药师',text:'药师只懂草药，不会魔法。',keys:['药师'],enabled:true,always_on:false,category:'人物'}
    const farLore = {...triggerLore,id:'far-lore',title:'未来人物',text:'未来人物的秘密设定',keys:['未来人物']}
    const loreInput = {...input,raw_script:'之后未来人物登场',author_note:'药师沉默',instruction:'修改药师的台词',settings:{...input.settings,lorebook:[triggerLore,farLore]}}
    const wholeLore = buildWriterContext(db,novelRow,loreInput,'write')
    assert(wholeLore.active_lore.includes('far-lore')) // The whole plan belongs to whole-chapter generation.
    const continuingLore = buildWriterContext(db,novelRow,loreInput,'continue')
    assert(!continuingLore.active_lore.includes('far-lore')); assert(continuingLore.active_lore.includes('note-lore'))
    const nearbyLore = buildWriterContext(db,novelRow,{...loreInput,author_note:'',before:'近处正文',selected:'他说话',after:'后文'},'revise')
    assert(nearbyLore.active_lore.includes('note-lore')); assert.equal(nearbyLore.lore_status[0].matched_source,'修改要求')
    assert(!nearbyLore.active_lore.includes('far-lore'))
    const draftOnly = {...loreInput, content:'旧稿已到航行第七天，废弃人物登场', settings:{...loreInput.settings,lorebook:[...loreInput.settings.lorebook,{...triggerLore,id:'draft-only',keys:['废弃人物']}]}}
    const fresh = await req('/writer/context','POST',draftOnly)
    assert(!fresh.user_prompt.includes(draftOnly.content)); assert(!fresh.active_lore.includes('draft-only'))
    assert(fresh.user_prompt.includes(draftOnly.raw_script)); assert(fresh.user_prompt.includes('第一个事件'))
    const resumed = await req('/writer/context','POST',{...draftOnly,mode:'continue'})
    assert(resumed.user_prompt.includes(draftOnly.content)); assert(resumed.active_lore.includes('draft-only'))
    assert(resumed.user_prompt.includes('从现有正文末尾继续'))
    const oldFirst = (await req('/writer/chapter/1')).content
    const newest = '最近的结尾🛰️'
    db.prepare('UPDATE novel_chapters SET content=? WHERE novel_id=? AND chapter_number=1').run('遥远旧段。'+'旧正文。'.repeat(1800)+newest,novel)
    const wideInput = {...input,settings:{...input.settings,memory:'必须完整保留的当前事实',recent_context_chars:6000,context_tokens:100000}}
    const wide = await req('/writer/context','POST',wideInput)
    const tightInput = {...wideInput,settings:{...wideInput.settings,context_tokens:wide.budget.estimated_input_tokens+wide.budget.output_tokens+wide.budget.reserved_tokens-6000}}
    const tight = await req('/writer/context','POST',tightInput)
    assert(!tight.budget.blocked); assert(tight.budget.trimmed.some((b:any)=>b.label.startsWith('近期正文')))
    assert(tight.blocks.find((b:any)=>b.label==='Memory').text===wideInput.settings.memory)
    assert(tight.blocks.find((b:any)=>b.label.startsWith('近期正文')).text.endsWith(newest))
    assert(!/[\uD800-\uDFFF]/u.test(tight.user_prompt))
    assert(tight.budget.estimated_input_tokens+tight.budget.output_tokens+tight.budget.reserved_tokens<=tight.budget.context_tokens)
    const tooLarge = {...wideInput,settings:{...wideInput.settings,memory:'完整事实'.repeat(2000),context_tokens:1024,max_output_tokens:128}}
    const blocked = await req('/writer/context','POST',tooLarge)
    assert(blocked.budget.blocked); assert.equal(blocked.blocks.find((b:any)=>b.label==='Memory').text,tooLarge.settings.memory)
    const oversizedLore = {...wideInput,settings:{...wideInput.settings,lorebook:[{...triggerLore,always_on:true,text:'常驻关键设定'.repeat(2000)}],context_tokens:6000,max_output_tokens:128}}
    const protectedLore = await req('/writer/context','POST',oversizedLore)
    assert(protectedLore.budget.blocked)
    assert.equal(protectedLore.blocks.find((b:any)=>b.label==='Lorebook · 药师').text,oversizedLore.settings.lorebook[0].text)
    const optionalLore = {...oversizedLore,raw_script:'药师登场',settings:{...oversizedLore.settings,lorebook:[{...triggerLore,text:'可选设定'.repeat(2000)}]}}
    const omittedLore = await req('/writer/context','POST',optionalLore)
    assert(!omittedLore.budget.blocked); assert(!omittedLore.active_lore.includes('note-lore'))
    assert.equal(omittedLore.lore_status[0].reason,'预算不足，未带入')
    const callsBeforeBlocked = calls
    await req('/writer/generate','POST',tooLarge,400); assert.equal(calls,callsBeforeBlocked)
    db.prepare('UPDATE novel_chapters SET content=? WHERE novel_id=? AND chapter_number=1').run(oldFirst,novel)
    console.log('✓ 输出与消息额度预留；优先裁剪较远正文并保留结尾、Memory与台本，必要内容过大时阻止模型调用；批注/修改触发与任务范围生效')
    const generated = await req('/writer/generate', 'POST', input)
    assert.equal(calls, 1); assert.equal(generated.content, output); assert.deepEqual(generated.context, preview); assert.equal(sent.messages[1].content, preview.user_prompt); assert.equal(sent.messages[0].content, preview.system_prompt)
    assert(!sent.messages[1].content.includes(input.content))
    assert.equal(row().content, '目标章原正文'); assert.equal((await req('/writer/chapter/3/history')).items.length, 1)
    const artifact = await req(`/writer/chapter/3/history/${generated.artifact_id}`)
    assert.deepEqual((await req('/writer/chapter/3')).last_context, preview)
    assert.equal(artifact.source.content, input.content); assert.equal(artifact.content, output)
    assert(!JSON.stringify(artifact).includes('test-only-secret'))
    console.log('✓ 复用已有模型、角色、世界观、文风和去 AI 味配置；上下文与实际请求一致，不注入未来正文或多层摘要')

    input.settings.system_prompt = '第二人称叙述，允许短句和破折号。'
    const continued = await req('/writer/context', 'POST', {...input, mode:'continue'})
    assert(!continued.system_prompt.includes(project.writing_template))
    assert(!continued.system_prompt.includes('【去 AI 味写法】'))
    assert(!continued.system_prompt.includes('破折号（——、—、--）一律不用'))
    assert(continued.system_prompt.includes('【本书固定写作要求】\n'+input.settings.system_prompt))
    assert(continued.system_prompt.includes('固定写作要求中作者明确自定义的要求与小说写作指引 > 本书文风指南'))
    assert(continued.user_prompt.includes('只输出新增正文'))
    output = '他把杯子推远。'
    const revision = { ...input, content: '门口🛰️他笑了。然后离开。', before: '门口🛰️', selected: '他笑了。', after: '然后离开。', instruction: '减少情绪解释' }
    const revised = await req('/writer/revise', 'POST', revision)
    assert(!revised.context.system_prompt.includes(project.writing_template))
    assert(revised.context.system_prompt.includes(input.settings.system_prompt))
    assert(!revised.context.system_prompt.includes('【去 AI 味写法】'))
    const {patchReviseSystemPrompt, writerSystemPrompt} = await import('../llm/prompts')
    const patchSystem = patchReviseSystemPrompt('短句，少旁白', input.settings.system_prompt)
    assert(patchSystem.includes(writerSystemPrompt(input.settings.system_prompt, '短句，少旁白')))
    assert(patchSystem.includes('JSON')); assert(!patchSystem.includes('【去 AI 味写法】'))
    assert(!writerSystemPrompt('', '').includes(project.writing_template))
    const restored = await req('/writer/context','POST',{...input,settings:{...input.settings,system_prompt:project.writing_template}})
    assert(restored.system_prompt.includes(project.writing_template))
    assert(revised.context.user_prompt.includes('原选区 4 字')); assert(revised.context.user_prompt.includes('精简时替换文字不得长于原选区')); assert(revised.context.user_prompt.includes('选区可能从句子中间开始或结束'));
    assert.equal(revised.replacement, output); assert.equal(row().content, '目标章原正文')
    await req('/writer/revise', 'POST', { ...revision, selected: '已改变的选区' }, 409)
    await req('/writer/memory/suggest', 'POST', { ...input, content: '未保存草稿' }, 409)
    output = '老赵答应借船。'
    const memory = await req('/writer/memory/suggest', 'POST', input)
    assert(!memory.context.system_prompt.includes(project.writing_template)); assert(!memory.context.system_prompt.includes(input.settings.system_prompt))
    assert(!memory.context.user_prompt.includes('林舟找老赵借船')); assert(!memory.context.user_prompt.includes('原有世界观')); assert.equal(memory.memory, output)
    assert.equal((await req('/writer/project')).settings.memory, '')
    console.log('✓ 选区与记忆建议只归档不覆盖正文，Unicode 选区校验、Memory 正文来源检查生效')

    const base = await req('/writer/chapter/3')
    const saved = { ...base, content: '采用后的新正文', author_note: '克制', base_chapter: base, chapter_idx: 3 }
    await req('/writer/save', 'POST', saved)
    assert.equal((await req('/chapters/3')).content, saved.content)
    assert.equal((await req('/writer/chapter/3')).author_note, '克制')
    const history = await req('/chapters/3/revisions')
    assert(history.length); assert.equal((await req(`/chapters/3/revisions/${history[0].id}`)).content, base.content)
    await req('/writer/save', 'POST', saved, 409)
    const settings = (await req('/writer/project')).settings
    const next = { ...settings, memory: '已确认前情', system_prompt: input.settings.system_prompt }
    await req('/writer/settings', 'POST', { settings: next, base_settings: settings })
    await req('/writer/settings', 'POST', { settings, base_settings: settings }, 409)
    assert.equal((await req('/writer/project')).settings.memory, next.memory)
    initSchema(); assert.equal((await req('/writer/chapter/3')).content, saved.content)
    assert.equal((await req('/writer/project')).settings.system_prompt,next.system_prompt)
    const one = await req('/writer/chapter/1'), three = await req('/writer/chapter/3')
    assert.equal(one.author_note,''); assert.equal(three.author_note,'克制')
    for (const [idx, c] of [[1,one],[3,three]] as const) {
      const ctx = await req('/writer/context','POST',{...input,...c,chapter_idx:idx,settings:next})
      assert.equal(ctx.blocks.find((b:any)=>b.label==='Memory').text,next.memory)
      assert.equal(ctx.blocks.find((b:any)=>b.label==='作者批注')?.text,c.author_note || undefined)
      assert(!ctx.user_prompt.includes('旧版N章差分摘要')); assert(!ctx.user_prompt.includes('旧版逐章记忆')); assert(!ctx.user_prompt.includes('旧版全局进度'))
    }
    console.log('✓ 批注逐章独立保存；各章共用同一当前 Memory，不读取旧的逐章快照、N章差分摘要或全局进度')

    console.log('✓ 默认模板预填，生成/续写/改写仅使用编辑后要求，删掉的规则不补回，可恢复默认；要求保存保留，事实记忆不受文风污染')
    console.log('✓ 保存写入原有章节表并保留修订，旧页面可读；并发正文和设定冲突拒绝，重复初始化保留数据')

    await req('/writer/project', 'GET', undefined, 404, other)
    await req('/writer/chapter/3/history', 'GET', undefined, 404, other)
    await req('/writer/project', 'GET', undefined, 401, '')
    await req(`/writer/chapter/1/history/${generated.artifact_id}`, 'GET', undefined, 404)
    const backup = await req('/writer/download?format=json')
    assert(!JSON.stringify(backup).includes('test-only-secret')); assert(backup.writer_artifacts.length === 3); assert(backup.chapter_revisions.length)
    const exported = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${novel}/writer/download?format=md`, { headers: { Authorization: 'Bearer ' + token } })
    const full = await exported.text(); assert(full.indexOf('第 1 章') < full.indexOf('第 3 章')); assert(full.indexOf('第 3 章') < full.indexOf('第 10 章')); assert(full.includes('采用后的新正文'))
    console.log('✓ 登录与小说权限没有旁路，历史记录限制所属章节，全书按章排序，备份不含密钥')

    // One current memory, immutable saved/finalized history, and no second legacy editor.
    const versions = await req('/writer/memory/history')
    assert.equal(versions.items.length, 3)
    assert(versions.items.some((v:any)=>v.kind==='backup'))
    assert(!JSON.stringify(versions.items).includes(next.memory))
    const latestMemory = await req(`/writer/memory/history/${versions.items[0].id}`)
    assert.equal(latestMemory.memory, next.memory)
    await req('/docs/architecture', 'PUT', {content: '不能再单独改世界观'}, 409)
    await req('/chapters/3/memory-review', 'POST', {}, 409)
    await req('/chapters/3/memory-review', 'PUT', {confirm:true}, 409)
    await req('/generate/finalize/3', 'POST', {}, 409)
    await req('/generate/architecture', 'POST', {}, 409)
    const finalBase = await req('/writer/chapter/3')
    await req('/writer/chapter/3/finalize', 'POST', {confirmed: false, base_chapter: finalBase, base_settings: next}, 400)
    const beforeFinalizeCalls = calls
    const finalizedState = await req('/writer/chapter/3/finalize', 'POST', {confirmed: true, base_chapter: finalBase, base_settings: next})
    assert.equal(finalizedState.settings.memory_through_chapter,3)
    Object.assign(next,finalizedState.settings)
    assert.equal(calls, beforeFinalizeCalls)
    assert.equal(row().status, 'finalized')
    const finalizedVersions = await req('/writer/memory/history')
    const checkpoint = await req(`/writer/memory/history/${finalizedVersions.items[0].id}`)
    assert.equal(checkpoint.kind, 'finalize'); assert.equal(checkpoint.chapter_number, 3); assert.equal(checkpoint.memory, next.memory)
    await req('/writer/chapter/3/finalize', 'POST', {confirmed: true, base_chapter: finalBase, base_settings: next})
    assert.equal((await req('/writer/memory/history')).items.length, finalizedVersions.items.length)
    const firstBase = await req('/writer/chapter/1')
    db.exec("CREATE TRIGGER reject_memory_snapshot BEFORE INSERT ON writer_memory_history WHEN NEW.kind='finalize' BEGIN SELECT RAISE(ABORT, '模拟快照写入失败'); END")
    await req('/writer/chapter/1/finalize', 'POST', {confirmed:true,base_chapter:firstBase,base_settings:next},400)
    assert.equal((db.prepare('SELECT status FROM novel_chapters WHERE novel_id=? AND chapter_number=1').get(novel) as any).status,'draft')
    db.exec('DROP TRIGGER reject_memory_snapshot')
    const {progressBeforeChapter} = await import('../llm/doc-snapshots')
    assert.equal(progressBeforeChapter(db, novel, 3), next.memory) // No missing-prefix error or old summary pipeline.
    output = JSON.stringify({outline:'林舟找到老赵，借到船。',suggestions:[],notes:[]})
    await req('/polish/outline/3', 'POST', {outline_revision: row().outline_revision, review_id: null})
    assert(sent.messages[1].content.includes(next.memory))
    const updatedState = {...next, memory: '新的当前记忆', memory_through_chapter:2, lorebook: next.lorebook.map((e: any) => e.id === 'source-world' ? {...e, text:'新的唯一世界观'} : e)}
    updatedState.lorebook.push({id:'note-match',title:'批注相关设定',text:'只有作者批注触发的设定',keys:['克制'],enabled:true,always_on:false,category:'人物'}, {id:'not-active',title:'远方角色',text:'未激活角色不应进入审稿',keys:['远方角色'],enabled:true,always_on:false,category:'人物'})
    await req('/writer/settings', 'POST', {settings: updatedState, base_settings: next})
    assert.equal((await req(`/writer/memory/history/${checkpoint.id}`)).memory, next.memory)
    await req('/writer/chapter/3/finalize', 'POST', {confirmed:true, base_chapter:finalBase, base_settings:next}, 409)
    output = JSON.stringify({summary:'已核对',issues:[],beats:[],scores:{prose:25,consistency:15,webnovel:20}})
    assert((await req('/docs')).architecture.includes('新的唯一世界观'))
    const reviewed = await req('/review/3', 'POST', {})
    const reviewSource = await req('/writer/chapter/3')
    const sameChapterPreview = await req('/writer/context','POST',{...input,...reviewSource,settings:updatedState,chapter_idx:3})
    assert.deepEqual([...reviewed.context.active_lore].sort(),[...sameChapterPreview.active_lore].sort())
    assert(reviewed.context.active_lore.includes('note-match')); assert(!reviewed.context.user_prompt.includes('未激活角色不应进入审稿'))
    assert(!reviewed.context.system_prompt.includes('文笔和 AI 腔由检测程序')); assert(reviewed.context.system_prompt.includes('不能按禁用词'))
    assert.equal(reviewed.review.aiChecks.length,0); assert.equal(reviewed.review.scores.prose,25)
    assert.deepEqual(reviewed.context.blocks.slice(-2).map((b:any)=>b.label),['作者批注','本次任务'])
    assert(!sent.messages[1].content.includes('旧版N章差分摘要')); assert(!sent.messages[1].content.includes('旧版逐章记忆')); assert(!sent.messages[1].content.includes('旧版全局进度'))
    assert(sent.messages[1].content.includes(updatedState.memory)); assert(sent.messages[1].content.includes('新的唯一世界观')); assert(!sent.messages[1].content.includes('原有世界观'))
    await req(`/writer/memory/history/${checkpoint.id}`, 'GET', undefined, 404, other)
    const secondNovel = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('合并迁移','author','existing')").run().lastInsertRowid)
    db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'architecture','旧版后改的世界观')").run(secondNovel)
    db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'writing_desk',?)").run(secondNovel, JSON.stringify({...next, schema_version:undefined,writing_template_version:undefined}))
    // Use the already-mounted router; project initialization is idempotent and keeps conflicts disabled.
    db.prepare("INSERT INTO novel_doc_snapshots(novel_id,chapter_number,doc_type,content) VALUES (?,2,'progress','保留原始旧快照')").run(secondNovel)
    const migrationResponse = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${secondNovel}/writer/project`, {headers:{Authorization:'Bearer '+token}})
    const migrated: any = await migrationResponse.json(); assert.equal(migrationResponse.status,200)
    assert.equal(migrated.settings.memory,next.memory)
    assert.equal(migrated.settings.writing_template_version,3)
    assert(migrated.settings.system_prompt.startsWith(project.writing_template))
    assert(migrated.settings.system_prompt.endsWith(next.system_prompt))
    assert.equal((db.prepare("SELECT memory FROM writer_memory_history WHERE novel_id=? AND kind='legacy'").get(secondNovel) as any).memory,'保留原始旧快照')
    assert(migrated.settings.lorebook.some((e:any)=>e.text==='旧版后改的世界观' && !e.enabled))
    const migrationHistoryCount = db.prepare('SELECT count(*) AS n FROM writer_memory_history WHERE novel_id=?').get(secondNovel) as any
    await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${secondNovel}/writer/project`, {headers:{Authorization:'Bearer '+token}})
    assert.equal((db.prepare('SELECT count(*) AS n FROM writer_memory_history WHERE novel_id=?').get(secondNovel) as any).n,migrationHistoryCount.n)
    assert.equal((db.prepare("SELECT content FROM novel_docs WHERE novel_id=? AND doc_type='architecture'").get(secondNovel) as any).content,'旧版后改的世界观')
    const thirdNovel = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('旧版写作模板','author','existing')").run().lastInsertRowid)
    db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'writing_desk',?)").run(thirdNovel,JSON.stringify({...next,writing_template_version:undefined}))
    const getThird = async () => (await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${thirdNovel}/writer/project`,{headers:{Authorization:'Bearer '+token}})).json() as Promise<any>
    const upgraded = await getThird()
    assert(upgraded.settings.system_prompt.startsWith(project.writing_template)); assert(upgraded.settings.system_prompt.endsWith(next.system_prompt))
    assert.equal((await getThird()).settings.system_prompt,upgraded.settings.system_prompt)
    assert.equal((db.prepare('SELECT count(*) AS n FROM writer_memory_history WHERE novel_id=?').get(thirdNovel) as any).n,0)
    console.log('✓ 当前 Memory/Lorebook 唯一来源；历史版本保留、定稿接口无模型调用、并发保护与旧资料无损合并生效')

    const {LEGACY_WRITING_TEMPLATE, PREVIOUS_WRITING_TEMPLATE, CHINESE_NOVEL_REQUIREMENT} = await import('../llm/prompts')
    const templateNovel = Number(db.prepare("INSERT INTO novels(title,creator_username,llm_config) VALUES ('默认规则升级','author','existing')").run().lastInsertRowid)
    const templateDoc = {...next,writing_template_version:1,system_prompt:LEGACY_WRITING_TEMPLATE}
    db.prepare("INSERT INTO novel_docs(novel_id,doc_type,content) VALUES (?,'writing_desk',?)").run(templateNovel,JSON.stringify(templateDoc))
    const getTemplate = async () => (await realFetch(`http://127.0.0.1:${(server.address() as any).port}/novels/${templateNovel}/writer/project`,{headers:{Authorization:'Bearer '+token}})).json() as Promise<any>
    assert.equal((await getTemplate()).settings.system_prompt,project.writing_template)
    db.prepare("UPDATE novel_docs SET content=? WHERE novel_id=? AND doc_type='writing_desk'").run(JSON.stringify({...templateDoc,system_prompt:'自定义规则：允许复杂比喻与长句。'}),templateNovel)
    assert.equal((await getTemplate()).settings.system_prompt,'自定义规则：允许复杂比喻与长句。')
    for (const suffix of ['', '\n\n【作者自定义要求】\n保留 ELA-7 型号。']) {
      db.prepare("UPDATE novel_docs SET content=? WHERE novel_id=? AND doc_type='writing_desk'").run(JSON.stringify({...templateDoc,writing_template_version:2,system_prompt:PREVIOUS_WRITING_TEMPLATE + suffix}),templateNovel)
      const languageUpgrade = await getTemplate()
      assert.equal(languageUpgrade.settings.writing_template_version,3)
      assert.equal(languageUpgrade.settings.system_prompt,project.writing_template + suffix)
      assert(languageUpgrade.settings.system_prompt.includes(CHINESE_NOVEL_REQUIREMENT))
      assert.equal((await getTemplate()).settings.system_prompt,languageUpgrade.settings.system_prompt)
    }
    for (const version of [2, 3]) {
      for (const custom of ['', '作者要求：保留双语对白。']) {
        db.prepare("UPDATE novel_docs SET content=? WHERE novel_id=? AND doc_type='writing_desk'").run(JSON.stringify({...templateDoc,writing_template_version:version,system_prompt:custom}),templateNovel)
        assert.equal((await getTemplate()).settings.system_prompt,custom)
      }
    }
    console.log('✓ 中文小说要求预填与旧默认升级，自定义和清空规则不覆盖；重复读取不重复追加')
    console.log('✓ 旧默认模板升级为简短建议，自定义规则保留；审稿与起草共用激活设定，文笔不再按禁词或标点机械扣分')
    const current = await req('/writer/chapter/3')
    input.content = current.content; input.settings = updatedState
    let signal!: () => void
    const entered = new Promise<void>(r => signal = r); reached = signal; held = new Promise<void>(r => release = r)
    const pending = req('/writer/generate', 'POST', input); await entered
    await req('/writer/save', 'POST', { ...current, content: '另一窗口的新正文', chapter_idx: 3, base_chapter: current })
    release!(); held = undefined; await pending
    assert.equal(row().content, '另一窗口的新正文'); assert.equal((await req('/writer/chapter/3/history')).items.length, 4)
    console.log('✓ 生成期间其他窗口保存优先；迟到的结果只进生成记录，不覆盖新正文')
    const removed = await req('/writer/chapter/10'), remainingMemory = (await req('/writer/project')).settings.memory
    const historyCount = (await req('/writer/memory/history')).items.length
    await req(`/chapters/${removed.id}`, 'DELETE')
    assert(!(await req('/writer/project')).chapters.some((c:any)=>c.chapter_idx===10))
    assert.equal((await req('/writer/project')).settings.memory,remainingMemory)
    assert.equal((await req('/writer/memory/history')).items.length,historyCount)
    assert.equal((await req('/writer/chapter/3')).content,'另一窗口的新正文')
    console.log('✓ 目录使用原生章节 ID 删除目标章，其他正文、当前 Memory 与历史快照保留')
    output = JSON.stringify([{note:'按作者要求修订',find:'另一窗口的新正文',replace:'按作者要求修订后的正文'}])
    await req('/revise/3','POST',{accepted_notes:['修改这一句'],rejected_notes:[]})
    assert(sent.messages[0].content.includes(updatedState.system_prompt)); assert(!sent.messages[0].content.includes('【去 AI 味写法】'))
    const beforeRegenerate = sentPrompts.length
    output = '按作者要求重新生成的正文。'
    await req('/generate/chapter/3','POST',{feedback:'按当前文风重写'})
    const regeneratedSystem = sentPrompts[beforeRegenerate].messages[0].content
    assert(regeneratedSystem.includes(updatedState.system_prompt)); assert(!regeneratedSystem.includes('【去 AI 味写法】'))
    console.log('✓ 审稿后的补丁修订与整章重写也使用作者编辑后的模板，后台不恢复删除的去 AI 味规则')
    const autoBase = await req('/writer/chapter/3'), autoSettings = (await req('/writer/project')).settings
    const autoInput = {...input,...autoBase,chapter_idx:3,settings:autoSettings}
    modelFailure = true
    await req('/writer/memory/suggest','POST',autoInput,400)
    modelFailure = false
    assert.equal((await req('/writer/project')).settings.memory,autoSettings.memory)
    assert.equal(row().status,'draft')
    output = '老赵已答应借船，明早七点出发。'
    const autoMemory = await req('/writer/memory/suggest','POST',autoInput)
    assert.equal(autoMemory.memory,output)
    assert.equal((await req('/writer/project')).settings.memory,autoSettings.memory) // Preview/cancel never commits.
    assert.equal(row().status,'draft')
    const autoRequest = {confirmed:true,base_chapter:autoBase,base_settings:autoSettings,memory:autoMemory.memory}
    await req('/writer/chapter/3/finalize','POST',{...autoRequest,memory:123},400)
    await req('/writer/chapter/3/finalize','POST',{...autoRequest,base_chapter:{...autoBase,content:'过期正文'}},409)
    await req('/writer/chapter/3/finalize','POST',{...autoRequest,base_settings:{...autoSettings,memory:'过期记忆'}},409)
    const autoVersions = (await req('/writer/memory/history')).items.length
    db.exec("CREATE TRIGGER reject_auto_memory BEFORE INSERT ON writer_memory_history WHEN NEW.kind='finalize' BEGIN SELECT RAISE(ABORT,'模拟定稿快照失败'); END")
    await req('/writer/chapter/3/finalize','POST',autoRequest,400)
    assert.equal((await req('/writer/project')).settings.memory,autoSettings.memory)
    assert.equal(row().status,'draft'); assert.equal((await req('/writer/memory/history')).items.length,autoVersions)
    db.exec('DROP TRIGGER reject_auto_memory')
    const autoResult = await req('/writer/chapter/3/finalize','POST',autoRequest)
    assert.equal(autoResult.settings.memory,autoMemory.memory); assert.equal(autoResult.chapter.status,'finalized')
    assert.equal((await req('/writer/project')).settings.memory,autoMemory.memory)
    const autoHistory = await req('/writer/memory/history')
    assert.equal(autoHistory.items.length,autoVersions+2) // prior current Memory is backed up separately
    assert.equal((await req(`/writer/memory/history/${autoHistory.items[0].id}`)).memory,autoMemory.memory)
    console.log('✓ 自动整理只产建议；确认后原子更新 Memory、定稿并留快照，模型失败、取消、过期或写入失败都保留原记忆与状态')
    const {invokeWithRetry} = await import('../llm/invoke')
    const {getLLMConfigById} = await import('../llm/config')
    const beforeGuarded = calls
    await assert.rejects(invokeWithRetry(getLLMConfigById(model)!, '系统', '超长原文'.repeat(1000),1,{novel_id:novel,task:'budget-guard',context_tokens:1024}),/请求未发送/)
    assert.equal(calls,beforeGuarded)

    // Both provider formats carry length metadata all the way through save/reopen/history.
    const memoryBeforeCut = (await req('/writer/project')).settings.memory
    const versionsBeforeCut = (await req('/writer/memory/history')).items.length
    for (const useSSE of [false, true]) {
      sse = useSSE; finishReason = 'length'; output = '林舟刚想说话，老赵却'
      const savedBefore = await req('/writer/chapter/3')
      const cutInput = {...input,...savedBefore,chapter_idx:3,settings:{...(await req('/writer/project')).settings, memory_through_chapter:2}}
      const beforeCalls: number = calls
      const cut = await req('/writer/generate','POST',cutInput)
      assert.equal(calls,beforeCalls+1); assert.equal(cut.incomplete,true); assert.equal(cut.finish_reason,'length')
      assert.equal(cut.content,output); assert.equal(row().content,savedBefore.content); assert.equal(row().writer_incomplete,0)
      const cutArtifact = await req(`/writer/chapter/3/history/${cut.artifact_id}`)
      assert.equal(cutArtifact.incomplete,true); assert.equal(cutArtifact.content,output)
      await req('/writer/save','POST',{...cutInput,...cut,base_chapter:savedBefore})
      initSchema()
      const reopened = await req('/writer/chapter/3')
      assert.equal(reopened.incomplete,true); assert.equal(reopened.content,output); assert.equal(row().status,'draft')
      const finalBody = {confirmed:true,base_chapter:reopened,base_settings:cutInput.settings}
      await req('/writer/chapter/3/finalize','POST',finalBody,400)
      await req('/writer/save','POST',{...reopened,chapter_idx:3,incomplete:'false',base_chapter:reopened},400)
      await req('/writer/save','POST',{...reopened,chapter_idx:3,base_chapter:{...reopened,incomplete:false}},409)
      const artifactsBefore = (await req('/writer/chapter/3/history')).items.length
      for (const path of ['/memory/suggest','/revise']) {
        const bad = await req('/writer'+path,'POST',{...cutInput,...reopened,before:'',selected:reopened.content,after:'',instruction:'润色'},400)
        assert.match(bad.message,/输出上限/); assert.equal(bad.memory,undefined); assert.equal(bad.replacement,undefined)
      }
      assert.equal((await req('/writer/chapter/3/history')).items.length,artifactsBefore)
      assert.equal((await req('/writer/project')).settings.memory,memoryBeforeCut)
      assert.equal((await req('/writer/memory/history')).items.length,versionsBeforeCut)
      const strictCalls: number = calls
      await assert.rejects(invokeWithRetry(getLLMConfigById(model)!, '系统', '任务',3,{novel_id:novel,task:'truncation-guard'}),/输出上限/)
      assert.equal(calls,strictCalls+1) // Unchanged token caps must not cause paid automatic retries.
      const log = db.prepare("SELECT * FROM llm_call_logs WHERE task='truncation-guard' ORDER BY rowid DESC LIMIT 1").get() as any
      assert.equal(log.response,output); assert.equal(log.status,'error'); assert.match(log.error,/输出上限/)
      const {invokeLLM} = await import('../llm/adapter')
      await assert.rejects(invokeLLM(getLLMConfigById(model)!, '系统', '任务'),/输出上限/)
      finishReason = 'stop'; output = '把杯子放下。“明早七点，三号泊位。”'
      const resumed = await req('/writer/generate','POST',{...cutInput,...reopened,mode:'continue'})
      assert.equal(resumed.content,reopened.content+'\n\n'+output); assert.equal(resumed.incomplete,false)
      assert.equal(row().writer_incomplete,1) // A successful candidate does not clear the saved flag until adopted.
      await req('/writer/save','POST',{...cutInput,...resumed,base_chapter:reopened})
      assert.equal((await req('/writer/chapter/3')).incomplete,false)
    }
    sse = false; finishReason = 'length'; output = ''
    const emptyCalls = calls
    await assert.rejects(invokeWithRetry(getLLMConfigById(model)!, '系统', '任务',3),/输出上限/)
    assert.equal(calls,emptyCalls+1)
    output = '<think>未写完的思考'
    const completeBase = await req('/writer/chapter/3')
    await req('/writer/generate','POST',{...input,...completeBase},400)
    assert.equal(row().content,completeBase.content)
    output = '不完整重写稿'
    await req('/generate/chapter/3','POST',{feedback:'重写'},500)
    assert.equal(row().content,completeBase.content); assert.equal(row().writer_incomplete,0)
    await req('/writer/save','POST',{...completeBase,chapter_idx:3,incomplete:true,base_chapter:completeBase})
    const manualBase = await req('/writer/chapter/3')
    const {incomplete: _oldFlag, ...legacySave} = manualBase
    await req('/writer/save','POST',{...legacySave,chapter_idx:3,base_chapter:legacySave})
    assert.equal(row().writer_incomplete,1) // Older clients cannot silently clear the warning.
    await req('/writer/save','POST',{...manualBase,chapter_idx:3,incomplete:false,base_chapter:manualBase})
    assert.equal((await req('/writer/chapter/3')).incomplete,false)
    finishReason = 'stop'
    console.log('✓ JSON/SSE 截断正文保留并归档，未完成状态随保存/重开保留、阻止定稿；续写完成或手工确认后解除')
    console.log('✓ 截断 Memory/选段/原生重写被拒绝，原记忆与正文保留；共享调用不自动重复长度失败，日志留存截断证据')


    const polishModel = Number(db.prepare("INSERT INTO llm_configs(name,base_url,model_name,api_key,temperature,max_tokens) VALUES ('polish-selected','https://writer-test.invalid/v1','polish-model','polish-only-secret',0.23,768)").run().lastInsertRowid)
    const savedProject = await req('/writer/project')
    const originalSettings = JSON.stringify(savedProject.settings), originalChapter = JSON.stringify(row())
    const originalArtifacts = (await req('/writer/chapter/3/history')).items.length
    const entry = {id:'new-unsaved-lore',title:'林舟',category:'人物',keys:['林舟'],enabled:true,always_on:false,text:'林舟是工程师。作者知道父亲仍活着，林舟只认为父亲失踪。计划：下一章发现坐标。原稿另一处称父亲已死亡，尚待核对。'}
    const polishInput = {...input,settings:{...savedProject.settings,model_id:String(polishModel),temperature:0.9},lore_entry:entry}
    expectedModel = 'polish-model'; output = '## 林舟\n### 身份\n- 工程师。\n### 知情范围与秘密\n- 作者知道父亲仍活着；林舟只认为父亲失踪。\n### 剧情计划\n- 下一章发现坐标。\n### 待核对\n- 原稿另一处称父亲已死亡。'
    const polished = await req('/writer/lore/polish','POST',polishInput)
    assert.equal(polished.text,output); assert.equal(polished.context.model.id,String(polishModel))
    assert.equal(sent.temperature,0.4) // Conservative editing does not change the saved creative temperature.
    assert.deepEqual(polished.context.blocks.map((b:any)=>b.label),['条目名称','条目分类','待整理设定原文','本次任务'])
    assert(polished.context.user_prompt.includes(entry.text)); assert(!polished.context.user_prompt.includes(input.raw_script)); assert(!polished.context.user_prompt.includes(input.content))
    assert(polished.context.system_prompt.includes('不能把计划写成事实')); assert(polished.context.system_prompt.includes('世界观')); assert(polished.context.system_prompt.includes('人物条目'))
    assert.equal(polished.context.budget.trimmed.length,0); assert(!polished.context.budget.blocked)
    assert.equal(JSON.stringify((await req('/writer/project')).settings),originalSettings); assert.equal(JSON.stringify(row()),originalChapter)
    assert.equal((await req('/writer/chapter/3/history')).items.length,originalArtifacts)
    assert(!JSON.stringify(polished).includes('polish-only-secret'))
    const beforeInvalidPolish = calls
    await req('/writer/lore/polish','POST',{...polishInput,lore_entry:{...entry,text:''}},400)
    await req('/writer/lore/polish','POST',{...polishInput,lore_entry:{...entry,text:'长'.repeat(50001)}},400)
    await req('/writer/lore/polish','POST',{...polishInput,settings:{...polishInput.settings,context_tokens:1024,max_output_tokens:1024}},400)
    await req('/writer/lore/polish','POST',polishInput,404,other)
    assert.equal(calls,beforeInvalidPolish)
    finishReason = 'length'; const beforeTruncatedPolish = calls
    const truncatedPolish = await req('/writer/lore/polish','POST',polishInput,400)
    assert.match(truncatedPolish.message,/输出上限/); assert.equal(calls,beforeTruncatedPolish+1); assert.equal(truncatedPolish.text,undefined)
    finishReason = 'stop'; output = '<think>模型没有完成整理'
    await req('/writer/lore/polish','POST',polishInput,400)
    assert.equal(JSON.stringify((await req('/writer/project')).settings),originalSettings); assert.equal(JSON.stringify(row()),originalChapter)
    expectedModel = 'existing-model'
    console.log('✓ 人物/世界设定整理使用当前所选模型，只发送目标条目；候选不覆盖设定与正文，权限、输入、预算和截断保护生效')

    const independent = {...savedProject.settings, lore_model_id: String(polishModel)}
    const persisted = await req('/writer/settings','POST',{settings:independent,base_settings:savedProject.settings})
    assert.equal(persisted.settings.lore_model_id,String(polishModel))
    assert.equal(persisted.settings.model_id,String(model))
    assert.equal((await req('/writer/project')).settings.lore_model_id,String(polishModel))
    expectedModel = 'polish-model'; output = '身份：工程师。'
    const separate = await req('/writer/lore/polish','POST',{...polishInput,settings:independent})
    assert.equal(separate.context.model.id,String(polishModel))
    assert.equal(separate.text,output)
    assert.equal(sent.temperature,0.23); assert.equal(sent.max_tokens,768)
    assert.equal(separate.context.budget.output_tokens,768)
    expectedModel = 'existing-model'
    const prosePreview = await req('/writer/context','POST',{...input,settings:independent})
    assert.equal(prosePreview.model.id,String(model))
    const fallback = {...persisted.settings,lore_model_id:''}
    const cleared = await req('/writer/settings','POST',{settings:fallback,base_settings:persisted.settings})
    const followed = await req('/writer/lore/polish','POST',{...polishInput,settings:cleared.settings})
    assert.equal(followed.context.model.id,String(model))
    await req('/writer/lore/polish','POST',{...polishInput,settings:{...cleared.settings,lore_model_id:'999999'}},400)
    console.log('✓ 设定模型独立保存并用于实际调用；正文仍用创作模型，清空后跟随，拒绝失效配置')

  } finally { globalThis.fetch = realFetch; server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); db.close() }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
