// 端到端冒烟测试：用本机 Chrome 驱动模拟模式下的前端
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
  await page.screenshot({ path: `${out}/1-login.png` })
  await page.locator('#c0').fill('R')
  await page.keyboard.type('T7K2M')
  await page.fill('#nick', '林')
  await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${out}/2-rooms.png` })
  log('房间卡片数', await page.locator('.room-card').count())

  // 进入正在进行的圆桌房间
  await page.click('.live-room')
  await page.waitForURL('**/rooms/r_weekend')
  await page.waitForSelector('.caret', { timeout: 5000 })
  log('流式输出中，发言者：', await page.locator('.interrupt-bar').innerText())
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${out}/3-round.png` })

  // @ 点名（名字带空格的成员不在此房间，测 Gemini）
  await page.click('.composer textarea')
  await page.keyboard.type('@gem')
  const pop = await page.locator('.mention-pop button').allInnerTexts()
  log('@ 弹窗：', pop)
  await page.keyboard.press('Enter')
  await page.keyboard.type('你能具体说说数据来源吗？')
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
  log('插话后人类消息数', await page.locator('.msg.human').count(), '发送中', await page.locator('.msg.pending').count())

  // 等当前发言结束，下一位应是 Gemini
  await page.waitForFunction(() => document.querySelector('.interrupt-bar')?.textContent?.startsWith('Gemini'), null, { timeout: 30000 })
  log('被 @ 后下一位：', await page.locator('.interrupt-bar').innerText())

  // 打断
  await page.waitForTimeout(800)
  await page.click('button:has-text("打断")')
  await page.waitForSelector('.interrupted', { timeout: 5000 })
  log('打断后状态：', await page.locator('.status-pill').innerText(), '，被打断标记数', await page.locator('.interrupted').count())
  await page.screenshot({ path: `${out}/4-interrupted.png` })

  // 继续 → 暂停（说完再停）
  await page.click('button:has-text("继续")')
  await page.waitForSelector('.caret')
  await page.click('button:has-text("暂停")')
  await page.waitForFunction(() => document.querySelector('.status-pill')?.textContent === '已暂停', null, { timeout: 30000 })
  log('暂停后正在输出的光标数：', await page.locator('.caret').count())

  // 其他三个模式
  for (const [id, name] of [['r_thesis', 'pipe'], ['r_energy', 'cross'], ['r_backend', 'debate']]) {
    await page.goto(`${URL}/rooms/${id}`)
    await page.waitForTimeout(700)
    if (await page.locator('button:has-text("开始")').count()) await page.click('button:has-text("开始")')
    if (await page.locator('button:has-text("继续")').count()) await page.click('button:has-text("继续")')
    await page.waitForTimeout(id === 'r_energy' ? 300 : 9000)
    await page.screenshot({ path: `${out}/5-${name}.png` })
    log(name, '消息数', await page.locator('.msg, .cv-card, .arg, .judge-note, .task').count(), '状态', await page.locator('.status-pill').innerText())
  }

  // 新建辩论房间：只选 2 个模型应提示错误
  await page.goto(URL + '/rooms')
  await page.waitForTimeout(800); await page.click('.mode-tile:has-text("辩论")')
  await page.fill('#topic', '周末要不要去爬山')
  const picked = page.locator('.pick-members').first().locator('.pm[aria-checked=true]')
  await picked.nth(2).click()
  await page.click('button:has-text("开始讨论")')
  log('2 个模型的辩论：', await page.locator('.sheet-foot .error-text').innerText())
  await page.locator('.pick-members').first().locator('.pm').nth(2).click()
  await page.screenshot({ path: `${out}/6-sheet.png` })
  await page.click('button:has-text("开始讨论")')
  await page.waitForURL(/rooms\/r_/)
  await page.waitForSelector('.arg', { timeout: 8000 })
  log('新辩论房间已开始，席位：', await page.locator('.debate-motion .faint').innerText())

  // 窄屏下控制按钮仍可见（评估 A2）
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(300)
  log('手机宽度下控制按钮可见：', await page.locator('.room-ctrls .btn').first().isVisible())
  await page.screenshot({ path: `${out}/7-mobile.png` })

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(URL + '/members'); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/8-members.png` })
  await page.goto(URL + '/usage'); await page.waitForTimeout(500); await page.screenshot({ path: `${out}/9-usage.png` })

  log('页面错误：', errors.length ? errors : '无')
  await browser.close()
})().catch((e) => { console.error('失败：', e.message); process.exit(1) })
