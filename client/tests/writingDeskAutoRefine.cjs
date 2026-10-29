// Browser check against the isolated writer UI fixture (preview/preview, mocked provider).
// Requires WRITER_TEST_ORIGIN and Playwright; PLAYWRIGHT_MODULE can point to an existing install.
const assert = require('node:assert/strict')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')

async function main() {
  assert(process.env.WRITER_TEST_ORIGIN, 'Supply an isolated test fixture URL; never a business instance')
  const origin = process.env.WRITER_TEST_ORIGIN
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true})
  try {
    const page = await browser.newPage(), calls = [], errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/writer/')) calls.push({path: new URL(r.url()).pathname.split('/').at(-1), body: r.postDataJSON()}) })
    await page.goto(origin + '/login')
    await page.getByPlaceholder('用户名').fill('preview'); await page.getByPlaceholder('密码').fill('preview')
    await page.getByRole('button', {name: '登 录'}).click()
    await page.waitForFunction(() => !!localStorage.getItem('token'))
    await page.goto(origin + '/novels/1')
    await page.getByText('流程验证 · 隔离测试书', {exact: true}).first().waitFor()
    await page.getByLabel('本章完整台本').fill('林远舟在酒吧找到老赵，说服借船。\n老赵听到林星河的名字后答应。\n海盗袭击，苏晴救援并搭船。\n艾拉报告军用通讯器线索。')
    const dialog = page.getByRole('dialog').filter({hasText: '全文精修'})
    const refinements = () => calls.filter(c => c.path === 'refine')
    const generate = async () => {
      await page.getByRole('button', {name: '台本生成正文'}).click()
      const confirm = page.getByRole('button', {name: '生成新草稿', exact: true})
      if (await confirm.count()) await confirm.click()
    }
    await generate(); await dialog.waitFor()
    assert.equal(refinements().length, 1)
    assert.equal(calls.some(c => c.path === 'check'), false, 'No redundant review before refinement')
    const draft = await page.getByLabel('小说正文').inputValue()
    assert.equal(refinements()[0].body.content, draft, 'Refine the new draft, never the stale React state')
    const start = calls.findIndex(c => c.path === 'generate')
    assert.deepEqual(calls.slice(start).map(c => c.path), ['generate', 'save', 'refine'])
    await page.getByRole('button', {name: '采用通过复核的修改'}).click()
    await dialog.waitFor({state: 'hidden'})
    await page.reload(); await page.getByLabel('小说正文').waitFor()
    assert.equal(refinements().length, 1, 'Accepting and reopening must not loop')
    assert((await page.getByLabel('小说正文').inputValue()).includes('老赵欠林星河一次撤离承诺。'))

    const edited = (await page.getByLabel('小说正文').inputValue()) + '\n\n作者手工调整了这一段。'
    const saved = page.waitForResponse(r => r.url().endsWith('/writer/save') && r.status() === 200 && r.request().postDataJSON()?.content === edited)
    await page.getByLabel('小说正文').fill(edited); await saved
    assert.equal(refinements().length, 1, 'Editing alone only saves; it never starts refinement')
    await page.getByRole('button', {name: '全文精修', exact: true}).click(); await dialog.waitFor()
    assert.equal(refinements().length, 2)
    assert.equal(refinements().at(-1).body.content, edited)
    await page.getByRole('button', {name: '保留原稿', exact: true}).click()

    // Retry is explicitly manual after an automatic refinement failure.
    const fail = route => route.fulfill({status: 400, json: {message: '模拟精修不可用'}})
    await page.route('**/writer/refine', fail)
    await generate(); await page.getByText(/自动精修未完成，可点击「全文精修」重试/).waitFor()
    assert.equal(refinements().length, 3)
    await page.unroute('**/writer/refine', fail)
    await page.getByRole('button', {name: '全文精修', exact: true}).click(); await dialog.waitFor()
    assert.equal(refinements().length, 4)
    await page.getByRole('button', {name: '保留原稿', exact: true}).click()

    // A truncated response is saved, but refined only after continuation completes.
    const partial = async route => { const r = await route.fetch(); const data = await r.json(); await route.fulfill({response: r, json: {...data, incomplete: true}}) }
    await page.route('**/writer/generate', partial)
    await generate(); await page.getByText('正文未完成：生成达到单次输出上限', {exact: true}).waitFor()
    assert.equal(refinements().length, 4)
    await page.unroute('**/writer/generate', partial)
    await page.getByRole('button', {name: '继续写', exact: true}).click(); await dialog.waitFor()
    assert.equal(refinements().length, 5)
    assert.equal(refinements().at(-1).body.mode, 'continue')
    assert.equal(refinements().at(-1).body.incomplete, false)
    await page.getByRole('button', {name: '保留原稿', exact: true}).click()
    await page.route('**/writer/save', route => route.fulfill({status: 400, json: {message: '模拟保存失败'}}))
    await generate(); await page.getByText('本章自动保存失败，当前编辑仍保留', {exact: true}).waitFor()
    assert.equal(refinements().length, 5, 'Do not refine a draft whose initial save failed')
    assert.deepEqual(errors, [])
    console.log('✓ 自动保存后精修、采用不循环、编辑后手动精修、失败重试、续写完整后精修、保存失败不精修')
  } finally { await browser.close() }
}
main().catch(e => { console.error(e); process.exitCode = 1 })
