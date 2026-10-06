import http from 'http'
import { invokeLLM } from '../llm/adapter'

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
  const port = (server.address() as any).port
  for (const path of Object.keys(cases)) {
    const cfg: any = { base_url: `http://127.0.0.1:${port}${path}`, model_name: 'x', temperature: 0, max_tokens: 10, timeout: 5 }
    try {
      console.log(path, '→', await invokeLLM(cfg, 's', 'u'))
    } catch (e: any) {
      console.log(path, '→ 报错:', e.message)
    }
  }
  server.close()
})
