/** 模型配置权限：非创建者不能改、删、测；改地址必须重填 Key，旧 Key 不会被发往新地址。 */
import assert from 'node:assert/strict'
import express from 'express'
import jwt from 'jsonwebtoken'
process.env.DB_PATH = ':memory:'
process.env.JWT_SECRET = 'llm-config-check-only'

async function main() {
  const { getDB } = await import('../db')
  const { initSchema } = await import('../schema')
  const { default: router } = await import('../routes/llm-configs')
  const db = getDB()
  initSchema()
  db.prepare('INSERT INTO llm_configs(name,base_url,model_name,api_key,created_by) VALUES (?,?,?,?,?)').run(
    'owned',
    'https://owner.invalid',
    'm',
    'owner-secret',
    'owner',
  )
  const app = express()
  app.use(express.json())
  app.use('/llm', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(r => server.once('listening', r))
  const realFetch = globalThis.fetch
  const sentTo: string[] = []
  globalThis.fetch = (async (url: any, options: any) => {
    sentTo.push(`${url} ${options.headers.Authorization}`)
    return Response.json({ choices: [{ message: { content: 'OK' }, finish_reason: 'stop' }] })
  }) as typeof fetch
  const sign = (username: string, role = 'user') => jwt.sign({ username, role }, process.env.JWT_SECRET!)
  const req = async (method: string, path: string, who: string, body?: any, status = 200) => {
    const r = await realFetch(`http://127.0.0.1:${(server.address() as any).port}/llm${path}`, {
      method,
      headers: { Authorization: `Bearer ${who}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const data: any = await r.json()
    assert.equal(r.status, status, JSON.stringify(data))
    return data
  }
  const row = () => db.prepare('SELECT * FROM llm_configs WHERE id=1').get() as any
  try {
    const attacker = sign('attacker')
    const listed = await req('GET', '/', attacker)
    assert(!JSON.stringify(listed).includes('owner-secret'))
    await req('PUT', '/1', attacker, { base_url: 'https://evil.invalid' }, 403)
    await req('POST', '/1/test', attacker, {}, 403)
    await req('DELETE', '/1', attacker, undefined, 403)
    assert.equal(row().base_url, 'https://owner.invalid')
    assert.equal(sentTo.length, 0)
    console.log('✓ 非创建者不能修改、测试或删除他人配置，Key 不出库')

    const owner = sign('owner')
    await req('PUT', '/1', owner, { base_url: 'https://new.invalid' }, 400)
    assert.equal(row().base_url, 'https://owner.invalid')
    await req('PUT', '/1', owner, { base_url: 'https://new.invalid', api_key: 'new-secret' })
    assert.equal(row().api_key, 'new-secret')
    await req('PUT', '/1', owner, { temperature: 0.3 })
    assert.equal(row().api_key, 'new-secret')
    await req('POST', '/1/test', owner, {})
    assert.deepEqual(sentTo, ['https://new.invalid/chat/completions Bearer new-secret'])
    console.log('✓ 修改 Base URL 必须重填 Key；其他字段留空 Key 时沿用原 Key')

    await req('PUT', '/1', sign('root', 'admin'), { name: 'renamed' })
    await req('DELETE', '/1', owner)
    assert.equal(row(), undefined)
    console.log('✓ 管理员可管理全部配置，创建者可删除自己的配置')
  } finally {
    globalThis.fetch = realFetch
    server.closeAllConnections()
    await new Promise<void>(r => server.close(() => r()))
    db.close()
  }
}
main().catch(e => {
  console.error(e)
  process.exitCode = 1
})
