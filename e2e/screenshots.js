// 给 README 拍截图（模拟模式 5179）。用法：node screenshots.js <输出目录>
const { chromium } = require('playwright-core')
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:5179'
const out = process.argv[2] || '.'

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 1 })
  await page.goto(URL + '/login')
  await page.locator('#c0').fill('R'); await page.keyboard.type('T7K2M'); await page.fill('#nick', '林')
  await page.click('button[type=submit]'); await page.waitForURL('**/rooms')

  // 1. 圆桌讨论（正在流式输出）
  await page.goto(URL + '/rooms/r_weekend')
  await page.waitForSelector('.caret', { timeout: 8000 })
  await page.waitForTimeout(2500)
  await page.screenshot({ path: `${out}/roundtable.png` })

  // 2. 交叉验证（已结束）
  await page.goto(URL + '/rooms/r_energy')
  await page.waitForSelector('.cv-card')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/crosscheck.png` })

  // 3. 代码运行预览
  await page.goto(URL + '/rooms/r_game')
  await page.waitForSelector('.code-btn.run')
  await page.locator('.code-btn.run').first().click()
  await page.waitForSelector('.runner-frame')
  await page.waitForTimeout(800)
  const fl = page.frameLocator('.runner-frame')
  await fl.locator('#start').click()
  for (let i = 0; i < 7; i++) await fl.locator('#hit').click()
  await page.waitForTimeout(300)
  await page.screenshot({ path: `${out}/code-run.png` })
  await browser.close()
})()
