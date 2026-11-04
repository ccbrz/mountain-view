/** A stream closed without finish_reason: prose keeps what arrived as a draft; structured output fails without retrying. */
import assert from 'node:assert/strict'
process.env.DB_PATH = ':memory:'

async function main() {
  const { invokeWithRetryResult } = await import('../llm/invoke')
  const config = {
    id: 1,
    name: 'glm',
    interface_format: 'OpenAI',
    base_url: 'https://text.novelai.net/oa/v1',
    model_name: 'glm-4-6',
    api_key: 'test-only',
    temperature: 0.7,
    max_tokens: 4096,
    timeout: 600,
  }
  const realFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response(
      'data: {"choices":[{"delta":{"content":"林远舟推开舱门，"}}]}\n\ndata: {"choices":[{"delta":{"content":"冷风灌了进来"}}]}\n\n',
    )
  }) as typeof fetch
  try {
    const prose = await invokeWithRetryResult(config, '系统', '写正文', 3, undefined, true)
    assert.deepEqual(prose, { text: '林远舟推开舱门，冷风灌了进来', incomplete: true, finish_reason: 'stream_cut' })
    assert.equal(calls, 1)
    await assert.rejects(invokeWithRetryResult(config, '系统', '输出 JSON', 3), /中途断开.*110 秒/)
    assert.equal(calls, 2, 'A cut stream is not retried; the same request would hit the same cap')
    console.log('✓ 断流时正文保留为未完成草稿；结构化输出明确报错且不重复调用')
  } finally {
    globalThis.fetch = realFetch
  }
}
main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
