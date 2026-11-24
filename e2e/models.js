// 成员页：手动输入模型名、温度滑杆禁用（模拟模式，端口 5179）
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
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

  await page.goto(URL + '/login')
  await page.locator('#c0').fill('R')
  await page.keyboard.type('T7K2M')
  await page.fill('#nick', '林')
  await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')
  await page.goto(URL + '/members')
  await page.waitForSelector('#f-model')

  // 第一位是 Claude Opus 5.5：温度应禁用
  log('Claude 温度禁用：', await page.locator('#f-temp').isDisabled(), '|', await page.locator('text=不支持调温度').count() === 1)

  // 切到 Qwen：温度可用
  await page.locator('.member-item', { hasText: 'Qwen' }).click()
  await page.waitForTimeout(200)
  log('Qwen 温度禁用：', await page.locator('#f-temp').isDisabled())

  // 手动输入模型名并保存
  await page.selectOption('#f-model', '__custom__')
  log('手动输入框出现：', await page.locator('input[aria-label=模型名]').isVisible())
  await page.fill('input[aria-label=模型名]', 'bad-name')
  await page.click('text=保存')
  await page.waitForTimeout(300)
  log('格式错误提示：', await page.locator('text=服务商/模型名"，例如').count() > 0)
  await page.fill('input[aria-label=模型名]', 'openai/gpt-6.1-sol')
  await page.screenshot({ path: `${out}/models-custom.png` })
  await page.click('text=保存')
  await page.waitForTimeout(500)

  // 切走再切回：仍显示手动输入的模型
  await page.locator('.member-item', { hasText: 'Claude' }).first().click()
  await page.waitForTimeout(200)
  log('切回 Claude 后手动框隐藏：', !(await page.locator('input[aria-label=模型名]').isVisible()))
  await page.locator('.member-item', { hasText: 'Qwen' }).click()
  await page.waitForTimeout(200)
  log('切回 Qwen 后模型：', await page.locator('input[aria-label=模型名]').inputValue())

  // 再从下拉框选回列表里的模型
  await page.selectOption('#f-model', 'dashscope/qwen-max')
  log('选回列表模型后手动框隐藏：', !(await page.locator('input[aria-label=模型名]').isVisible()))

  log('页面错误：', errors.length ? errors : '无')
  await browser.close()
})()
