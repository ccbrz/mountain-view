import assert from 'node:assert/strict'

process.env.DB_PATH = ':memory:'
async function main() {
  const {buildModelWriterContext, requireWriterBudget} = await import('../llm/writer-context')
  const {countInputTokens} = await import('../llm/adapter')
  const {invokeWithRetryResult} = await import('../llm/invoke')
  const {initLogStore} = await import('../llm/logstore')
  initLogStore()
  const config = {id: 1, name: 'test', interface_format: 'OpenAI', base_url: 'https://text.novelai.net/oa/v1', model_name: 'xialong-v1', api_key: 'test-only', temperature: 0.7, max_tokens: 8192, timeout: 5}
  const input = {chapter_idx: 1, title: '测试', mode: 'continue', raw_script: '借船', content: '正文'.repeat(2000), author_note: '', settings: {
    model_id: '1', system_prompt: '中文写作', memory: '', temperature: 0.7, max_output_tokens: 8192, recent_context_chars: 0, context_tokens: 32768,
    lorebook: [{id: 'world', title: '世界', text: '世界观'.repeat(3500), keys: [], enabled: true, always_on: true, category: '世界'}],
  }}
  const novel = {id: 1}, realFetch = globalThis.fetch
  let mode = 'ok', requests: any[] = [], generations = 0
  globalThis.fetch = (async (url: any, options: any) => {
    const body = JSON.parse(options.body)
    assert.equal(options.headers.Authorization, 'Bearer test-only')
    if (String(url).endsWith('/internal/token-count')) {
      requests.push(body)
      assert.equal(body.model, 'xialong-v1')
      if (mode === 'fail') return new Response('unavailable', {status: 503})
      return Response.json({length: mode === 'invalid' ? -1 : mode === 'over' ? 50000 : 9231})
    }
    assert.equal(String(url), config.base_url + '/chat/completions')
    generations++
    return new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n')
  }) as typeof fetch
  try {
    const full = await buildModelWriterContext(null, novel, input, config)
    assert.equal(full.budget.method, 'novelai-token-count')
    assert.equal(full.budget.remaining_tokens, 32768 - 8192 - 512 - 9231)
    assert.equal(full.budget.trimmed.length, 0)
    assert(full.user_prompt.includes(input.content)); assert(full.user_prompt.includes(input.settings.lorebook[0].text))
    assert.equal(requests[0].prompt, full.system_prompt + '\n\n' + full.user_prompt)
    assert.equal(requests.length, 1); assert.equal(generations, 0)
    assert.equal((await invokeWithRetryResult(config, full.system_prompt, full.user_prompt, 1, {novel_id: 1, task: 'test', context_tokens: 32768})).text, 'OK')
    mode = 'over'
    const tooLarge = await buildModelWriterContext(null, novel, input, config)
    assert.throws(() => requireWriterBudget(tooLarge), /超过配置窗口/)
    await assert.rejects(invokeWithRetryResult(config, full.system_prompt, full.user_prompt, 1, {novel_id: 1, task: 'test', context_tokens: 32768}), /超出配置窗口/)
    assert.equal(generations, 1)
    for (mode of ['fail', 'invalid']) {
      const fallback = await buildModelWriterContext(null, novel, input, config)
      assert(fallback.budget.blocked); assert(fallback.warnings.some(w => w.includes('回退')))
    }
    const before = requests.length
    assert.equal(await countInputTokens({...config, base_url: 'https://other.invalid/v1'}, '', ''), undefined)
    assert.equal(requests.length, before)
    console.log('✓ NovelAI 实际计数保留完整中文材料，生成前检查一致；真实超限与计数失败仍受保护，其他服务不请求此接口')
  } finally { globalThis.fetch = realFetch }
}
main().catch(err => {console.error(err); process.exitCode = 1})
