// 运行预览端到端测试（模拟模式，端口 5179）
const { chromium } = require('playwright-core')
// 本机 Chrome 路径，可用环境变量 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:5179'
const out = process.argv[2] || '.'
const log = (...a) => console.log('·', ...a)

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(URL + '/login')
  await page.locator('#c0').fill('R')
  await page.keyboard.type('T7K2M')
  await page.fill('#nick', '林')
  await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')
  await page.goto(URL + '/rooms/r_game')
  await page.waitForSelector('.code-block')
  log('代码块数', await page.locator('.code-block').count(), '| 运行按钮数', await page.locator('.code-btn.run').count(), '（应为 3 和 2：css 块不能单独运行）')
  await page.screenshot({ path: `${out}/run-1-msgs.png` })

  // 运行 HTML
  await page.locator('.code-btn.run').first().click()
  await page.waitForSelector('.runner-frame')
  await page.waitForTimeout(800)
  const consoleText = () => page.locator('.runner-console').innerText()
  log('控制台：', (await consoleText()).replace(/\n/g, ' | '))
  const fl = page.frameLocator('.runner-frame')
  log('CSS 已注入：', await fl.locator('body').evaluate((b) => getComputedStyle(b).textAlign))

  // 沙箱隔离
  const frame = page.frames().find((f) => f !== page.mainFrame())
  log('读父页面：', await frame.evaluate(() => { try { return typeof parent.document.cookie } catch (e) { return '被拦截 ' + e.name } }))
  log('请求接口：', await frame.evaluate(() => fetch('/api/auth/me').then(() => '成功（不应该）', (e) => '被拦截 ' + e.name)))

  // 玩一局：3 次点击
  await fl.locator('#start').click()
  for (let i = 0; i < 3; i++) await fl.locator('#hit').click()
  await page.screenshot({ path: `${out}/run-2-playing.png` })
  await page.waitForTimeout(10500)
  log('最高分：', await fl.locator('#best').innerText())

  // 重新运行：最高分应保留
  await page.click('text=重新运行')
  await page.waitForTimeout(800)
  log('重新运行后最高分：', await page.frameLocator('.runner-frame').locator('#best').innerText(), '| 控制台清空后再报错：', (await consoleText()).includes('TypeError'))

  // 清空保存的数据
  await page.click('text=清空保存的数据')
  await page.waitForTimeout(800)
  log('清空后最高分：', await page.frameLocator('.runner-frame').locator('#best').innerText())

  // 发回房间
  await page.fill('input[aria-label=补充说明]', '点"开始"后能玩，但没有重新开始按钮')
  await page.click('text=发回房间')
  await page.waitForTimeout(800)
  const last = page.locator('.msg.human').last()
  log('发回的消息：', (await last.innerText()).replace(/\n/g, ' | '))
  log('@ 高亮：', await last.locator('.at').count())
  await page.screenshot({ path: `${out}/run-3-reported.png` })

  // 运行 JS 片段
  await page.locator('.code-btn.run').nth(1).click()
  await page.waitForTimeout(800)
  log('JS 控制台：', (await consoleText()).replace(/\n/g, ' | '))
  await page.screenshot({ path: `${out}/run-4-js.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  log('Esc 关闭：', (await page.locator('.runner-frame').count()) === 0)

  log('页面错误：', errors.length ? errors : '无')
  await browser.close()
})()
