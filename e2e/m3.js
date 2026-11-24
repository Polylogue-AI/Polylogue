// 第三批联调：流水线、交叉验证、辩论三种模式，前端 VITE_MOCK=0 + 后端 LLM_MODE=fake
const { chromium } = require('playwright-core')
// 本机 Chrome 路径，可用环境变量 CHROME_PATH 覆盖
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL = 'http://localhost:5180'
const out = process.argv[2] || '.'
let failed = 0
const ok = (cond, msg, extra = '') => { console.log(cond ? '✓' : '✗', msg, extra); if (!cond) failed++ }

async function createRoom(page, mode, topic, pickExtra = 0) {
  await page.goto(URL + '/rooms')
  await page.waitForSelector('.mode-tile')
  await page.waitForTimeout(400)
  await page.click(`.mode-tile:has-text("${mode}")`)
  await page.fill('#topic', topic)
  // 默认选前 3 个模型，再按需多选
  const pms = page.locator('.pick-members').first().locator('.pm')
  for (let i = 0; i < pickExtra; i++) await pms.nth(3 + i).click()
  await page.click('button:has-text("开始讨论")')
  await page.waitForURL(/\/rooms\/r_/)
}
const waitStatus = (page, text, timeout = 120000) =>
  page.waitForFunction((t) => document.querySelector('.status-pill')?.textContent === t, text, { timeout })

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))

  await page.goto(URL + '/login')
  await page.locator('#c0').click(); await page.keyboard.type('TBLE27')
  await page.fill('#nick', '林'); await page.click('button[type=submit]')
  await page.waitForURL('**/rooms')

  /* ---- 流水线：4 个模型 → 规划者 1、执行者 2、审查者 1 ---- */
  await createRoom(page, '流水线', '写一份读书会活动方案', 1)
  await page.waitForSelector('.member-mini:has-text("规划者")')
  const duties = await page.locator('.member-mini .r').allInnerTexts()
  ok(duties.some((d) => d.startsWith('规划者')) && duties.some((d) => d.startsWith('审查者')) && duties.filter((d) => d.startsWith('执行者')).length === 2, '流水线职责自动分配', duties.filter((d) => d.includes('者')).map((d) => d.split(' ')[0]).join('、'))
  await page.waitForSelector('.task:not(.empty)', { timeout: 15000 })
  ok(true, '任务看板出现任务')
  // 执行阶段应能看到多个任务同时在进行
  let maxRunning = 0
  for (let i = 0; i < 60; i++) {
    maxRunning = Math.max(maxRunning, await page.locator('.task .st.run').count())
    if (maxRunning >= 2) break
    await page.waitForTimeout(200)
  }
  ok(maxRunning >= 2, '执行者并发工作', `同时进行的任务最多 ${maxRunning} 个`)
  const bar = await page.locator('.interrupt-bar').innerText()
  ok(bar.includes('同时发言'), '并发时显示多位发言者', bar)
  await page.screenshot({ path: `${out}/m3-pipe-running.png` })
  await waitStatus(page, '已结束')
  const mergeDone = await page.locator('.pipe-col').nth(3).locator('.task:not(.empty)').count()
  ok(mergeDone >= 1, '流水线结束，汇总列有已完成的任务', `${mergeDone} 个`)
  ok(await page.locator('.summary-card').count() === 1, '流水线有汇总')
  const verdicts = await page.locator('.reply-to .st').allInnerTexts()
  ok(verdicts.length >= 1, '审查结论显示在对应任务的消息上', verdicts.join('、'))
  const rawJson = await page.locator('.msg .text').evaluateAll((els) => els.filter((e) => /^\s*[{[]|"tasks"\s*:|"verdict"\s*:/.test(e.textContent)).length)
  ok(rawJson === 0, '界面上没有出现原始 JSON')
  await page.screenshot({ path: `${out}/m3-pipe.png`, fullPage: true })

  /* ---- 交叉验证：4 个模型 → 回答者 3、裁判 1 ---- */
  await createRoom(page, '交叉验证', '2024 年全球数据中心耗电量是多少？', 1)
  await waitStatus(page, '已结束')
  const answers = await page.locator('.cv-card').count()
  ok(answers === 3, '三位回答者各给出一份回答', `${answers} 份`)
  const reviewSummary = await page.locator('details.reviews summary').innerText().catch(() => '')
  ok(/（3 份）/.test(reviewSummary), '匿名互评 3 份', reviewSummary.slice(0, 12))
  await page.locator('details.reviews summary').click()
  const reviewText = await page.locator('details.reviews').innerText()
  ok(/回答 [A-C]/.test(reviewText) && /\/10/.test(reviewText), '互评用匿名代号打分')
  const memberNames = await page.locator('.cv-card .h b').allInnerTexts()
  const bodies = (await page.locator('details.reviews .rv .md').allInnerTexts()).join(' ')
  ok(!memberNames.some((n) => bodies.includes(n)), '互评正文里没有出现作者名字')
  ok(await page.locator('.verdict').count() === 1, '裁判给出结论')
  const agree = await page.locator('.verdict-lists li').count()
  ok(agree >= 2, '结论里列出共识和分歧', `${agree} 条`)
  await page.screenshot({ path: `${out}/m3-cross.png`, fullPage: true })

  /* ---- 辩论：3 个模型 → 正方、反方、裁判，3 回合 ---- */
  await createRoom(page, '辩论', '读书会应该每周举办一次')
  const scoreSeen = new Set()
  for (let i = 0; i < 400; i++) {
    const s = await page.locator('.scale .side').first().innerText()
    scoreSeen.add(s)
    if ((await page.locator('.status-pill').innerText()) === '已结束') break
    await page.waitForTimeout(250)
  }
  ok((await page.locator('.status-pill').innerText()) === '已结束', '辩论结束')
  const pro = await page.locator('.arg.pro').count(), con = await page.locator('.arg.con').count()
  ok(pro === 3 && con === 3, '正反方各发言 3 次', `${pro} / ${con}`)
  ok(await page.locator('.judge-note').count() === 3, '裁判每回合点评一次', `${await page.locator('.judge-note').count()} 次`)
  const finalScore = await page.locator('.scale .side').first().innerText()
  ok(/正方 \d+/.test(finalScore), '倾向条显示裁判评分', `${[...scoreSeen].join(' → ')}`)
  ok(await page.locator('.debate .verdict').count() === 1, '裁判给出最终判断')
  await page.screenshot({ path: `${out}/m3-debate.png`, fullPage: true })

  /* ---- 并发阶段打断：交叉验证的回答阶段点打断，再继续 ---- */
  await createRoom(page, '交叉验证', '打断测试：远程办公效率更高吗？', 1)
  await page.waitForSelector('button:has-text("打断"):not([disabled])', { timeout: 15000 })
  await page.waitForTimeout(500)
  await page.click('button:has-text("打断")')
  await waitStatus(page, '已暂停', 10000)
  ok(true, '并发回答阶段可以打断，进入暂停')
  const cut = await page.locator('.interrupted, .cv-card').count()
  await page.click('button:has-text("继续")')
  await waitStatus(page, '已结束')
  ok(await page.locator('.verdict').count() === 1, '打断后继续，仍能走完并出结论', `打断时已有 ${cut} 张卡片`)
  const cards = await page.locator('.cv-card').count()
  const labels = await page.locator('.cv-card .h .faint').allInnerTexts()
  ok(cards === 3 && labels.join(',') === '回答 A,回答 B,回答 C', '重做后仍是 3 张回答卡片，代号 A/B/C', `${cards} 张：${labels.join('、')}`)
  await page.screenshot({ path: `${out}/m3-cross-interrupt.png`, fullPage: true })

  ok(errors.length === 0, '页面无报错', errors.join(' | '))
  console.log(failed ? `\n${failed} 项失败` : '\n全部通过')
  await browser.close()
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('中止：', e.message.split('\n')[0]); process.exit(2) })
