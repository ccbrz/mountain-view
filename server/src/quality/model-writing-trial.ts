/** Replays a saved prompt against a configured model without changing the book or call logs. */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { countInputTokens, invokeLLMResult } from '../llm/adapter'

async function main() {
  const [configName, inputDir] = process.argv.slice(2)
  assert(configName && inputDir, 'Usage: tsx model-writing-trial.ts <config-name> <prior-trial-directory>')
  const root = path.resolve(__dirname, '../../..'),
    source = path.resolve(inputDir)
  const db = new Database(path.join(root, 'data/app.db'), { readonly: true })
  const config: any = db.prepare('SELECT * FROM llm_configs WHERE name = ?').get(configName)
  db.close()
  assert(config, 'Configured model not found')
  const previous = JSON.parse(fs.readFileSync(path.join(source, 'result.json'), 'utf8'))
  config.temperature = previous.temperature
  config.max_tokens = previous.max_tokens
  const system = fs.readFileSync(path.join(source, 'system.txt'), 'utf8')
  const user = fs.readFileSync(path.join(source, 'user.txt'), 'utf8')
  const dir = path.join(
    root,
    'demo-output',
    config.model_name + '-writing-trial-' + new Date().toISOString().replace(/[:.]/g, '-'),
  )
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'system.txt'), system)
  fs.writeFileSync(path.join(dir, 'user.txt'), user)
  const inputTokens = await countInputTokens(config, system, user)
  assert(inputTokens !== undefined && inputTokens + config.max_tokens + 512 <= 32768, 'Input budget check failed')
  const metadata = {
    model: config.model_name,
    provider: new URL(config.base_url).hostname,
    source,
    temperature: config.temperature,
    max_tokens: config.max_tokens,
    input_tokens: inputTokens,
    prompt_sha256: createHash('sha256').update(JSON.stringify({ system, user })).digest('hex'),
  }
  fs.writeFileSync(path.join(dir, 'request-meta.json'), JSON.stringify(metadata, null, 2))
  console.log(JSON.stringify({ dir, ...metadata }))
  const started = Date.now()
  const response = await invokeLLMResult(config, system, user)
  fs.writeFileSync(path.join(dir, 'prose.txt'), response.content)
  const chars = Array.from(response.content.replace(/\s/gu, '')).length
  const report = {
    ...metadata,
    chars,
    target_chars: 4000,
    acceptable_range: [2800, 5200],
    length_ok: chars >= 2800 && chars <= 5200,
    finish_reason: response.finish_reason,
    refusal: response.refusal,
    elapsed_seconds: Math.round((Date.now() - started) / 1000),
  }
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
