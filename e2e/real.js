// 前后端联调测试：前端 VITE_MOCK=0 + 后端 LLM_MODE=fake，两个独立浏览器会话
const { chromium } = require('playwright-core')
// 本机 Chrome 路径，可用环境变量 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:5180'
const out = process.argv[2] || '.'
let failed = 0
const ok = (cond, msg, extra = '') => { console.log(cond ? '✓' : '✗', msg, extra); if (!cond) failed++ }

async function login(page, code, name) {
  await page.goto(URL + '/login')
  await page.locator('#c0').click()
  await page.keyboard.type(code)
  await page.fill('#nick', name)
  await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')
}
const statusOf = (p) => p.locator('.status-pill').innerText()
const speakingOf = (p) => p.locator('.interrupt-bar').innerText()

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const errors = []
  const mk = async (label) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    page.on('pageerror', (e) => errors.push(`${label}: ${e.message}`))
    return { ctx, page }
  }
  const A = await mk('林')
  const B = await mk('小雨')

  // 1. 管理员登录，在设置页生成邀请码
  await login(A.page, 'tble27', '林')
  ok(true, '管理员用小写邀请码登录（大小写不敏感）')
  await A.page.click('a:has-text("设置")')
  await A.page.waitForSelector('.provider-logo')
  ok(await A.page.locator('.key-state').first().innerText() === '可用', '设置页显示模型服务可用（假模型模式）')
  await A.page.fill('input[aria-label="邀请码备注"]', '给小雨')
  await A.page.click('button:has-text("生成")')
  await A.page.waitForSelector('.group-row:has-text("给小雨") .invite-code')
  const code = await A.page.locator('.group-row:has-text("给小雨") .invite-code').innerText()
  ok(/^[A-HJ-NP-Z2-9]{6}$/.test(code), '生成的邀请码格式正确', code)

  // 2. 第二个人用邀请码登录；同码换名字应被拒
  await login(B.page, code, '小雨')
  ok(true, '小雨用邀请码登录')
  const C = await mk('冒名')
  await C.page.goto(URL + '/login')
  await C.page.locator('#c0').click(); await C.page.keyboard.type(code)
  await C.page.fill('#nick', '别人'); await C.page.click('button[type=submit]')
  await C.page.waitForTimeout(500)
  ok((await C.page.locator('.login-error').innerText()).length > 0, '同一邀请码换名字登录被拒', await C.page.locator('.login-error').innerText())
  await C.ctx.close()
  await A.page.reload(); await A.page.waitForSelector('.invite-code')
  ok((await A.page.locator('.group-row:has-text("给小雨")').innerText()).includes('已被 小雨 使用'), '邀请码显示已被小雨使用')
  ok(await A.page.locator('.group-row:has-text("给小雨") button:has-text("作废")').count() === 0, '已使用的邀请码不显示作废按钮')
  await A.page.screenshot({ path: `${out}/r1-settings.png` })

  // 3. 林新建圆桌房间，邀请小雨，选 3 个模型、2 轮
  await A.page.goto(URL + '/rooms')
  await A.page.waitForTimeout(500)
  await A.page.click('.mode-tile:has-text("圆桌")')
  await A.page.fill('#topic', '周末读书会选哪本书？')
  await A.page.locator('.pick-members').nth(1).locator('.pm:has-text("小雨")').click()
  await A.page.click('button:has-text("开始讨论")')
  await A.page.waitForURL(/\/rooms\/r_/)
  const roomUrl = A.page.url()
  ok(true, '房间已创建', roomUrl.split('/').pop())
  ok((await A.page.locator('.cv-q').innerText()).includes('读书会'), '圆桌页面显示讨论的问题')

  // 4. 小雨进入同一房间，两人看到同一条逐字输出
  await B.page.goto(roomUrl)
  await A.page.waitForSelector('.caret'); await B.page.waitForSelector('.caret')
  // 等第一条发言结束，比较两边的同一条
  await A.page.waitForFunction(() => document.querySelectorAll('.msg.ai').length >= 2, null, { timeout: 20000 })
  const tA = await A.page.locator('.msg.ai .text').first().innerText()
  await B.page.waitForFunction(() => document.querySelectorAll('.msg.ai').length >= 2, null, { timeout: 5000 })
  const tB = await B.page.locator('.msg.ai .text').first().innerText()
  ok(tA.length > 5 && tA === tB, '两人看到同一条发言，内容完全一致', `${tA.slice(0, 24)}…`)
  ok((await A.page.locator('.member-mini:has-text("小雨")').innerText()).includes('在线'), '林看到小雨在线')

  // 5. 小雨按"后面的座位在前"的顺序 @ 两个模型，后端应按输入顺序安排
  const aiNames = (await B.page.locator('.member-mini').evaluateAll((els) => els.map((e) => e.childNodes[1]?.textContent?.trim()))).filter((n) => n && n !== '林' && n !== '小雨')
  const [first, , third] = aiNames
  await B.page.click('.composer textarea')
  await B.page.keyboard.type(`@${third.slice(0, 3)}`); await B.page.keyboard.press('Enter')
  await B.page.keyboard.type('和 ')
  await B.page.keyboard.type(`@${first.slice(0, 3)}`); await B.page.keyboard.press('Enter')
  await B.page.keyboard.type('先说说你们俩的看法')
  await B.page.keyboard.press('Enter')
  await A.page.waitForSelector('.msg.human:has-text("先说说你们俩")')
  ok(true, '林收到小雨的插话')
  // 当前发言结束后，下一位应是 third，再下一位是 first
  const order = []
  let lastSpeaker = (await speakingOf(A.page)).split(' ')[0]
  for (let i = 0; i < 80 && order.length < 2; i++) {
    await A.page.waitForTimeout(250)
    const s = (await speakingOf(A.page)).split(' ')[0]
    if (s && s !== lastSpeaker && !s.startsWith('已')) { order.push(s); lastSpeaker = s }
  }
  ok(order[0] === third && order[1] === first, '多个 @ 按输入顺序发言', `期望 ${third}→${first}，实际 ${order.join('→')}`)
  const promptHasReply = await A.page.locator('.msg.ai .text').last().innerText()
  ok(promptHasReply.length > 0, `${first} 正在回应`)

  // 6. 打断：林点打断 → 两边都显示"被打断"、状态已暂停
  await A.page.waitForSelector('.caret')
  await A.page.waitForTimeout(400)
  await A.page.click('button:has-text("打断")')
  await B.page.waitForSelector('.interrupted', { timeout: 5000 })
  ok(await statusOf(B.page) === '已暂停', '打断后小雨那边也显示已暂停')

  // 7. 继续 → 暂停（说完再停）
  await B.page.click('button:has-text("继续")')
  await A.page.waitForSelector('.caret')
  await A.page.click('button:has-text("暂停")')
  ok(await A.page.locator('.caret').count() === 1, '点暂停后当前发言仍在继续')
  await A.page.waitForFunction(() => document.querySelector('.status-pill')?.textContent === '已暂停', null, { timeout: 30000 })
  ok(await A.page.locator('.caret').count() === 0, '说完这句后才暂停')

  // 8. 跳过
  await A.page.click('button:has-text("继续")')
  await A.page.waitForSelector('.caret')
  const before = (await speakingOf(A.page)).split(' ')[0]
  await A.page.waitForTimeout(300)
  await A.page.click('button:has-text("跳过")')
  await A.page.waitForFunction((b) => { const t = document.querySelector('.interrupt-bar')?.textContent ?? ''; return t && !t.startsWith(b) }, before, { timeout: 8000 })
  ok(await statusOf(A.page) === '进行中', '跳过后讨论继续', `${before} → ${(await speakingOf(A.page)).split(' ')[0]}`)

  // 9. 断线重连：小雨在一条发言输出途中断网，等这条结束后恢复，应补回全文
  await B.page.waitForSelector('.caret')
  await B.page.waitForTimeout(300)
  const streamingId = await B.page.locator('.msg.ai').count()
  await B.ctx.setOffline(true)
  // 等林这边这条发言结束、下一条开始
  const nA = await A.page.locator('.msg.ai').count()
  await A.page.waitForFunction((n) => document.querySelectorAll('.msg.ai').length > n, nA, { timeout: 30000 })
  const fullText = await A.page.locator('.msg.ai .text').nth(nA - 1).innerText()
  await B.ctx.setOffline(false)
  await B.page.waitForTimeout(4000)
  const bText = await B.page.locator('.msg.ai .text').nth(streamingId - 1).innerText()
  ok(bText.replace(/\s/g, '') === fullText.replace(/\s/g, ''), '断线期间结束的发言，重连后补回全文', `长度 ${bText.length}/${fullText.length}`)

  // 10. 等讨论结束，两边都看到汇总
  await A.page.waitForSelector('.summary-card', { timeout: 90000 })
  await A.page.waitForFunction(() => document.querySelector('.status-pill')?.textContent === '已结束', null, { timeout: 30000 })
  await B.page.waitForSelector('.summary-card', { timeout: 10000 })
  ok(true, '两边都看到汇总，讨论结束')
  const nAi = await A.page.locator('.msg.ai, .summary-card').count()
  const nBi = await B.page.locator('.msg.ai, .summary-card').count()
  ok(nAi === nBi, '两边消息数一致', `${nAi} / ${nBi}`)
  await A.page.screenshot({ path: `${out}/r2-room.png`, fullPage: false })

  // 11. 刷新页面，消息从后端完整恢复
  await B.page.reload()
  await B.page.waitForSelector('.summary-card')
  ok(await B.page.locator('.msg.ai, .summary-card').count() === nAi, '刷新后从后端恢复全部消息')

  // 12. 非管理员看不到"添加模型成员"和邀请码管理
  await B.page.goto(URL + '/members'); await B.page.waitForTimeout(500)
  ok(await B.page.locator('button:has-text("添加模型成员")').count() === 0, '非管理员看不到添加成员按钮')
  await B.page.goto(URL + '/settings'); await B.page.waitForTimeout(500)
  ok(await B.page.locator('button:has-text("生成")').count() === 0, '非管理员看不到生成邀请码')

  // 13. 用量页能加载真实数据
  await A.page.goto(URL + '/usage'); await A.page.waitForSelector('.stat-main .big')
  ok((await A.page.locator('.stat-main .big').innerText()).startsWith('¥'), '用量页加载', await A.page.locator('.stat-main .big').innerText())
  await A.page.screenshot({ path: `${out}/r3-usage.png` })

  ok(errors.length === 0, '页面无报错', errors.join(' | '))
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('中止：', e.message.split('\n')[0]); process.exit(2) })
