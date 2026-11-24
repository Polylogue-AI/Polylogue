// GitHub Pages 演示版验证：子路径 /polylogue/、模拟模式、深链接
const { chromium } = require('playwright-core')
// 本机 Chrome 路径，可用环境变量 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:5181/polylogue'
;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(BASE + '/')
  await page.waitForURL('**/polylogue/login')
  console.log('· 打开首页 → 跳到', new URL(page.url()).pathname, '| 标题', await page.title())
  await page.locator('#c0').fill('R'); await page.keyboard.type('T7K2M'); await page.fill('#nick', '林')
  await page.click('button[type=submit]')
  await page.waitForURL('**/polylogue/rooms')
  console.log('· 登录后', new URL(page.url()).pathname, '| 房间卡片', await page.locator('.room-card').count())
  await page.click('text=设置'); await page.waitForURL('**/polylogue/settings')
  console.log('· 侧栏跳转', new URL(page.url()).pathname)
  await page.goto(BASE + '/rooms/r_game')
  await page.waitForTimeout(800)
  console.log('· 深链接刷新', new URL(page.url()).pathname, '| 品牌', await page.locator('.brand b').innerText(), '| 代码块', await page.locator('.code-block').count())
  await page.screenshot({ path: process.argv[2] || 'pages.png' })
  console.log('· 页面错误：', errors.length ? errors : '无')
  await browser.close()
})()
