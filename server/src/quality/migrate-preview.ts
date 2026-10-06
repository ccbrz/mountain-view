import path from 'path'
import fs from 'fs'
import { getLLMConfigByName } from '../llm/config'
import { invokeWithRetry } from '../llm/invoke'
import * as P from '../llm/prompts'

/**
 * id=1 迁移预览：用清理后的种子，按架构路由同样的顺序生成角色档案和世界观。
 * 只写 demo-output/，不碰数据库。确认后再入库。
 * 用法：tsx src/quality/migrate-preview.ts [configName]
 */
const OUT = path.join(__dirname, '../../../demo-output')

async function main() {
  const cfg = getLLMConfigByName(process.argv[2] || 'DeepSeek V4-Pro')!
  const seed = fs.readFileSync(path.join(OUT, 'migrate-id1-seed.md'), 'utf8')
  const ctx = { novel_id: 1, task: 'migrate-preview' }
  const charsFile = path.join(OUT, 'migrate-id1-characters.md')
  // 已生成过就复用，方便只重跑世界观
  const chars = fs.existsSync(charsFile)
    ? fs.readFileSync(charsFile, 'utf8')
    : await invokeWithRetry(cfg, P.SYSTEM_CHARACTERS, P.USER_CHARACTERS(seed), 3, ctx)
  fs.writeFileSync(charsFile, chars)
  const world = await invokeWithRetry(cfg, P.SYSTEM_WORLD_BUILDING, P.USER_WORLD_BUILDING(`${seed}\n\n${chars}`), 3, ctx)
  fs.writeFileSync(path.join(OUT, 'migrate-id1-world.md'), world)
  console.log('chars', chars.length, 'world', world.length)
}
main().catch((e) => { console.error(e); process.exit(1) })
