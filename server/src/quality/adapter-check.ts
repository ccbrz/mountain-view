import http from 'http'
import assert from 'node:assert/strict'
import { invokeLLM, OutputTruncatedError } from '../llm/adapter'

// 本地假网关：按路径返回不同格式，content-type 故意给错，验证 adapter 按内容识别
const sse = [
  'data: {"choices":[{"delta":{"content":"你"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}',
  '',
  'data: [DONE]',
  '',
].join('\r\n')
const json = JSON.stringify({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] })
const cases: Record<string, [string, string]> = {
  '/json-ok': ['application/json', json],
  '/sse-ok': ['text/event-stream', sse],
  '/sse-as-json': ['application/json', sse],
  '/json-as-sse': ['text/event-stream', json],
  '/garbage': ['text/plain', '<html>bad gateway</html>'],
}

const server = http.createServer((req, res) => {
  const [type, body] = cases[req.url!.replace('/chat/completions', '')] || ['text/plain', '']
  res.writeHead(200, { 'content-type': type }).end(body)
})
server.listen(0, async () => {
  const realFetch = globalThis.fetch
  try {
    const port = (server.address() as any).port
    for (const path of Object.keys(cases)) {
      const cfg: any = { base_url: `http://127.0.0.1:${port}${path}`, model_name: 'x', temperature: 0, max_tokens: 10, timeout: 5 }
      if (path === '/garbage') await assert.rejects(invokeLLM(cfg, 's', 'u'), /无法解析模型响应/)
      else assert.equal(await invokeLLM(cfg, 's', 'u'), '你好')
    }
    const cfg: any = { base_url: 'https://text.novelai.net/oa/v1', model_name: 'xialong-v1', api_key: 'test-only', temperature: 0.7, max_tokens: 8192, timeout: 5 }
    let mode = 'stop'
    globalThis.fetch = (async (url: any, options: any) => {
      const body = JSON.parse(options.body)
      assert.equal(body.stream, String(url).startsWith('https://text.novelai.net/') ? true : undefined)
      assert.equal(body.max_tokens, 8192)
      assert.equal(options.headers.Authorization, 'Bearer test-only')
      if (!body.stream) return Response.json({ choices: [{ message: { content: '你好' }, finish_reason: 'stop' }] })
      if (mode === 'cut') return new Response('data: {"choices":[{"delta":{"content":"半句"}}]}\n\n')
      return new Response(sse.replace('"stop"', JSON.stringify(mode)))
    }) as typeof fetch
    assert.equal(await invokeLLM(cfg, '', '请仅回复 OK。'), '你好')
    mode = 'length'
    await assert.rejects(invokeLLM(cfg, '', '任务'), (err: any) => err instanceof OutputTruncatedError && err.partial === '你好')
    mode = 'cut'
    await assert.rejects(invokeLLM(cfg, '', '任务'), /中途断开/)
    assert.equal(await invokeLLM({ ...cfg, base_url: 'https://other.invalid/v1' }, '', '任务'), '你好')
    const kayra = {...cfg, model_name: 'kayra-v1', max_tokens: 500}
    let nativeCalls = 0, complete = true
    globalThis.fetch = (async (url: any, options: any) => {
      assert.equal(String(url), 'https://text.novelai.net/ai/generate')
      const body = JSON.parse(options.body)
      assert.equal(body.parameters.max_length, 250)
      assert.equal(body.parameters.prefix, 'special_instruct')
      assert.equal(body.parameters.use_string, true)
      nativeCalls++
      if (nativeCalls % 2 === 1) return Response.json({output: '身份：工程师。\nEND_OF_'})
      assert(body.input.endsWith('身份：工程师。\nEND_OF_'))
      return Response.json({output: complete ? 'RESPONSE\n多余文本不应保留' : '仍未完成'})
    }) as typeof fetch
    assert.equal(await invokeLLM(kayra, '保留事实', '整理设定'), '身份：工程师。')
    assert.equal(nativeCalls, 2)
    complete = false
    await assert.rejects(invokeLLM(kayra, '', '整理设定'), OutputTruncatedError)
    assert.equal(nativeCalls, 4)
    await assert.rejects(invokeLLM({...kayra, max_tokens: 2001}, '', '整理设定'), /最多 2000/)
    await assert.rejects(invokeLLM(kayra, '', '很长'.repeat(1500)), /上下文不足/)
    assert.equal(nativeCalls, 4)
    console.log('✓ Kayra 原生接口、分段衔接、结束标记与上下文/输出边界保护通过')
    console.log('✓ JSON/SSE 解析、NovelAI 流式请求、截断保护及其他服务兼容性通过')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  } finally {
    globalThis.fetch = realFetch
    server.close()
  }
})
