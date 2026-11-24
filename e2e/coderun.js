// 代码运行前端测试（模拟模式 5179，或传 real 连真实后端 5180）
const { chromium } = require('playwright-core')
// 本机 Chrome 路径，可用环境变量 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const REAL = process.argv[3] === 'real'
const URL = REAL ? 'http://localhost:5180' : 'http://localhost:5179'
const out = process.argv[2] || '.'
const log = (...a) => console.log('·', ...a)

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => { if (!/onclick/.test(e.message)) errors.push(e.message) })
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(URL + '/login')
  await page.locator('#c0').fill(REAL ? 'T' : 'R')
  await page.keyboard.type(REAL ? 'BLE27' : 'T7K2M')
  await page.fill('#nick', '林')
  await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')

  // 设置页
  await page.goto(URL + '/settings')
  await page.waitForTimeout(800)
  log('设置页沙箱：', (await page.locator('.settings-sec', { hasText: '代码运行' }).locator('.group-row').innerText()).replace(/\n/g, ' | '))

  // 成员页
  await page.goto(URL + '/members')
  await page.waitForSelector('#f-model')
  await page.waitForTimeout(500)
  const toggle = page.locator('button[aria-label=允许运行代码]')
  log('第一位成员：', await page.locator('.editor-head h2').innerText(), '| 开关', await toggle.getAttribute('aria-checked'), '| 禁用', await toggle.isDisabled())
  if (!REAL) {
    await page.locator('.member-item', { hasText: 'Llama' }).click()
    await page.waitForTimeout(200)
    log('Llama（不支持工具）：禁用', await toggle.isDisabled(), '|', await page.locator('.setting-line', { hasText: '允许运行代码' }).locator('span').first().innerText())
    await page.locator('.member-item', { hasText: 'GPT' }).click()
    await page.waitForTimeout(200)
    log('GPT：开关', await toggle.getAttribute('aria-checked'))
  }
  await page.screenshot({ path: `${out}/cr-members.png` })

  // 房间
  const roomId = process.argv[4] || 'r_game'
  await page.goto(URL + '/rooms/' + roomId)
  await page.waitForSelector('.msg')
  await page.waitForTimeout(800)
  const cards = page.locator('.run-card')
  log('运行卡片数：', await cards.count())
  if (await cards.count()) {
    log('第一张卡片：', (await cards.first().locator('.run-head').innerText()).replace(/\n/g, ' '), '|', (await cards.first().locator('.run-out').first().innerText()).replace(/\n/g, ' ').slice(0, 80))
    await cards.first().locator('summary').click()
    log('展开代码：', (await cards.first().locator('.run-code pre').first().innerText()).split('\n')[0])
    await cards.first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${out}/cr-card.png` })
  }

  // 在服务器运行
  const btn = page.locator('.code-btn', { hasText: '在服务器运行' })
  log('"在服务器运行"按钮数：', await btn.count())
  if (await btn.count()) {
    const before = await cards.count()
    await btn.first().click()
    await btn.first().click().catch(() => {})
    await page.waitForTimeout(300)
    log('提示：', await page.locator('.toast').allInnerTexts().catch(() => []))
    await page.waitForFunction((n) => document.querySelectorAll('.run-card').length > n &&
      !document.querySelectorAll('.run-card')[document.querySelectorAll('.run-card').length - 1].querySelector('.run-spin'), before, { timeout: 60000 })
    const last = page.locator('.run-msg').last()
    log('新卡片：', (await last.locator('.who').innerText()).replace(/\n/g, ' '), '|', await last.locator('.reply-to').innerText().catch(() => '无来源'), '|',
      (await last.locator('.run-head').innerText()).replace(/\n/g, ' '), '|', (await last.locator('.run-out').first().innerText()).replace(/\n/g, ' ').slice(0, 100))
    await last.scrollIntoViewIfNeeded()
    await page.screenshot({ path: `${out}/cr-server-run.png` })
  }
  log('页面错误：', errors.length ? errors : '无')
  await browser.close()
})()
