/**
 * 浏览器内的模拟后端。行为就是 docs/03-接口契约.md 的参考实现：
 * 后端遇到契约没写清楚的地方，可以看这里是怎么做的。
 *
 * 数据只存在内存里，刷新页面就会重置（登录状态保存在 localStorage）。
 */
import type { Api, ConnectOptions, RoomConnection } from './client'
import type {
  AiMember, ClientEvent, CreateRoomInput, Duty, Invite, Message, MessageKind, MessageMeta, ModelOption,
  PipeTask, Room, RoomState, RoomSummary, Seat, ServerEvent, Usage, User,
} from './types'
import { ApiError } from './types'

/* ---------------- 种子数据 ---------------- */

const users: User[] = [
  { id: 'u_lin', name: '林', short: '林', color: '#FFD8A8', is_admin: true, monthly_limit_cny: 100 },
  { id: 'u_zhe', name: '阿哲', short: '哲', color: '#CDE8FF', is_admin: false, monthly_limit_cny: 100 },
  { id: 'u_yu', name: '小雨', short: '雨', color: '#D9F2DF', is_admin: false, monthly_limit_cny: 100 },
  { id: 'u_kai', name: '凯文', short: '凯', color: '#F3D9F7', is_admin: false, monthly_limit_cny: 100 },
]

const models: ModelOption[] = [
  { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5', provider: 'anthropic', available: true, supports_temperature: false },
  { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5', provider: 'anthropic', available: true, supports_temperature: false },
  { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5', provider: 'anthropic', available: true, supports_temperature: false },
  { id: 'openai/gpt-5', label: 'GPT-5', provider: 'openai', available: true, supports_temperature: false },
  { id: 'openai/gpt-5-mini', label: 'GPT-5 mini', provider: 'openai', available: true, supports_temperature: false },
  { id: 'gemini/gemini-2.5-pro', label: 'Gemini 2.5 Pro', provider: 'gemini', available: false, supports_temperature: true },
  { id: 'deepseek/deepseek-chat', label: 'DeepSeek Chat', provider: 'deepseek', available: true, supports_temperature: true },
  { id: 'dashscope/qwen-max', label: 'Qwen Max', provider: 'dashscope', available: true, supports_temperature: true },
  { id: 'ollama/llama3.1:8b', label: 'Llama 3.1 8B（本地）', provider: 'ollama', available: true, supports_temperature: true },
]

const ANTI_ECHO = '必须指出至少一个前面的人没有提到的问题。'
let members: AiMember[] = [
  { id: 'ai_claude', name: 'Claude', short: 'C', color: '#C9842F', model: 'anthropic/claude-opus-5-5', role: '产品顾问', system_prompt: '你是产品顾问。先判断用户真正要解决的问题，再给建议。' + ANTI_ECHO, temperature: 0.6, max_chars: 300, monthly_budget_cny: 40, can_mention: false, month_cost_cny: 31.4 },
  { id: 'ai_gpt', name: 'GPT', short: 'G', color: '#14996F', model: 'openai/gpt-5', role: '工程评估', system_prompt: '你是工程评估。从实现难度、时间、维护成本三个方面评估方案，给出具体的工作量估计。', temperature: 0.4, max_chars: 300, monthly_budget_cny: 40, can_mention: false, month_cost_cny: 22.85 },
  { id: 'ai_gemini', name: 'Gemini', short: 'Ge', color: '#3C78F0', model: 'gemini/gemini-2.5-pro', role: '用户研究', system_prompt: '你是用户研究员。用真实用户行为和数据说话，没有数据时明确说"这是假设"。', temperature: 0.7, max_chars: 300, monthly_budget_cny: 30, can_mention: false, month_cost_cny: 9.6 },
  { id: 'ai_deepseek', name: 'DeepSeek', short: 'D', color: '#36458F', model: 'deepseek/deepseek-chat', role: '唱反调', system_prompt: '你是唱反调的人。找出前面所有观点里最薄弱的地方并反驳，不要附和任何人。', temperature: 0.9, max_chars: 300, monthly_budget_cny: 15, can_mention: true, month_cost_cny: 5.22 },
  { id: 'ai_qwen', name: 'Qwen', short: 'Q', color: '#8659E8', model: 'dashscope/qwen-max', role: '中文写作', system_prompt: '你负责中文写作。语言简洁、准确，避免空话和套话，术语前后统一。', temperature: 0.5, max_chars: 600, monthly_budget_cny: 15, can_mention: false, month_cost_cny: 3.18 },
  { id: 'ai_llama', name: 'Llama 本地', short: 'L', color: '#3A3A3E', model: 'ollama/llama3.1:8b', role: '草稿员', system_prompt: '你是草稿员。快速写出第一版，不追求完美，后面会有人审查。', temperature: 0.8, max_chars: null, monthly_budget_cny: null, can_mention: false, month_cost_cny: 0 },
]

/** 每个字的模拟价格（元） */
const PRICE: Record<string, number> = { ai_claude: 0.0009, ai_gpt: 0.0007, ai_gemini: 0.0005, ai_deepseek: 0.00012, ai_qwen: 0.0002 }

/* ---------------- 工具函数 ---------------- */

let idCounter = 1000
const uid = (p: string) => `${p}${(idCounter++).toString(36)}`
const now = () => new Date().toISOString()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const clone = <T>(x: T): T => structuredClone(x)
const round4 = (n: number) => Math.round(n * 10000) / 10000

function currentUser(): User {
  const id = localStorage.getItem('rt_mock_user')
  const u = users.find((x) => x.id === id)
  if (!u) throw new ApiError(401, 'unauthorized', '请先登录')
  return u
}
function person(id: string): User | AiMember | undefined {
  return users.find((u) => u.id === id) ?? members.find((m) => m.id === id)
}
function seatOf(id: string, duty: Duty | null): Seat {
  const u = users.find((x) => x.id === id)
  if (u) return { id, kind: 'human', name: u.name, short: u.short, color: u.color, duty: null, role: null }
  const m = members.find((x) => x.id === id)!
  return { id, kind: 'ai', name: m.name, short: m.short, color: m.color, duty, role: m.role }
}

function assignDuties(mode: Room['mode'], ids: string[], given: Record<string, Duty> = {}): Record<string, Duty> {
  const d: Record<string, Duty> = {}
  const n = ids.length
  ids.forEach((id, i) => {
    if (mode === 'round') d[id] = 'speaker'
    if (mode === 'pipe') d[id] = n === 2 ? (i === 0 ? 'planner' : 'executor') : i === 0 ? 'planner' : i === n - 1 ? 'reviewer' : 'executor'
    if (mode === 'cross') d[id] = i === n - 1 ? 'judge' : 'answerer'
    if (mode === 'debate') d[id] = i === n - 1 ? 'judge' : i % 2 === 0 ? 'pro' : 'con'
  })
  return { ...d, ...given }
}

/* ---------------- 发言脚本 ---------------- */

interface Turn {
  speaker: string
  kind?: MessageKind
  meta?: MessageMeta
  text: string | ((e: Engine) => string)
  mentions?: string[]
  replyTo?: 'prev'
  before?: (e: Engine) => void
  after?: (e: Engine) => void
}

const pick = <T>(arr: T[], i: number) => arr[i % arr.length]

const GENERIC: Record<string, string[]> = {
  speaker: [
    '我先说结论：这件事最大的不确定性不在技术上，而在**谁会真的用它**。建议先找 5 个目标用户聊一次，再决定做多大。',
    '补充一个前面没人提到的风险：**维护成本**。做出来只是开始，之后每个月要花多少时间修和更新，这个要提前算清楚。',
    '我不同意"先做再说"。两周时间很短，如果第一周方向就错了，后面没有回头的余地。应该先用半天写清楚"不做什么"。',
    '从实现上看，可以拆成三步：\n\n1. 先做最小可用版本，只保留一个核心功能\n2. 找朋友试用一周，记录卡住的地方\n3. 根据反馈决定第二个功能',
    '有一个数据值得参考：同类工具里，留存最好的都是"打开就能用、不用配置"的。所以第一版的上手成本比功能数量更重要。',
  ],
}

function genericText(e: Engine, speaker: string, i: number): string {
  const m = person(speaker)!
  const human = e.takeHumanNote()
  const body = pick(GENERIC.speaker, i + speaker.length)
  const head = human ? `**先回应 ${human.name}：** ${human.reply}\n\n` : ''
  return `${head}${body}` + (i === 0 ? `\n\n（${m.name}，角色：${(m as AiMember).role ?? ''}）` : '')
}

function roundScript(room: Room, duties: Record<string, Duty>, fromRound: number, toRound: number): Turn[] {
  const ais = room.seats.filter((s) => s.kind === 'ai').map((s) => s.id)
  const turns: Turn[] = []
  let i = 0
  for (let r = fromRound; r <= toRound; r++) {
    for (const id of ais) {
      const k = i++
      turns.push({ speaker: id, text: (e) => genericText(e, id, k), before: (e) => e.setRound(r) })
    }
  }
  const summarizer = Object.keys(duties).find((k) => duties[k] === 'summarizer') ?? ais[ais.length - 1]
  turns.push({
    speaker: summarizer,
    kind: 'summary',
    text: `**阶段结论**\n\n1. 大家一致认为第一版要小，只保留一个核心功能。\n2. 动手前先花两天验证需求是否真实存在。\n3. 维护成本要提前估算，避免做完没人管。\n\n**保留的分歧：** 是否需要先写清楚"不做什么"，还没有达成一致。`,
  })
  return turns
}

function pipeScript(room: Room, duties: Record<string, Duty>): Turn[] {
  const planner = room.seats.find((s) => duties[s.id] === 'planner')!.id
  const execs = room.seats.filter((s) => duties[s.id] === 'executor').map((s) => s.id)
  const reviewer = room.seats.find((s) => duties[s.id] === 'reviewer')?.id ?? planner
  const titles = ['梳理背景与已有方案', '写核心部分初稿', '列出风险与待验证的问题']
  const tasks: PipeTask[] = titles.map((title, i) => ({ id: `t_${i + 1}`, stage: 'exec', title, assignee_id: execs[i % execs.length], status: 'queued', rework_count: 0 }))
  const setTask = (e: Engine, id: string, patch: Partial<PipeTask>) => {
    e.state.mode_state.tasks = e.state.mode_state.tasks!.map((t) => (t.id === id ? { ...t, ...patch } : t))
  }
  const turns: Turn[] = [
    {
      speaker: planner,
      text: `我把任务拆成 ${tasks.length} 个小节：\n\n${tasks.map((t, i) => `${i + 1}. **${t.title}**，交给 ${person(t.assignee_id)!.name}`).join('\n')}\n\n全部通过审查后由我统一术语和格式。`,
      before: (e) => { e.state.mode_state.tasks = [{ id: 't_plan', stage: 'plan', title: '拆分任务', assignee_id: planner, status: 'running', rework_count: 0 }] },
      after: (e) => { e.state.mode_state.tasks = [{ id: 't_plan', stage: 'plan', title: '拆分任务', assignee_id: planner, status: 'done', rework_count: 0 }, ...clone(tasks)] },
    },
  ]
  for (const t of tasks) {
    turns.push({
      speaker: t.assignee_id, meta: { task_id: t.id },
      text: `**${t.title}**\n\n这一节的初稿已完成，约 1200 字。要点：先交代问题来源，再对比两种主流做法，最后说明我们为什么选第二种。引用了知识库里的 3 份资料。`,
      before: (e) => setTask(e, t.id, { status: 'running' }),
      after: (e) => setTask(e, t.id, { status: 'done', stage: 'review' }),
    })
  }
  tasks.forEach((t, i) => {
    if (i === 0) {
      turns.push({
        speaker: reviewer, meta: { task_id: t.id, verdict: 'needs_fix' },
        text: `**${t.title}：需要修改。** 第 2 段引用的数字和原文不符（原文是 27%，这里写成了 37%），已退回 ${person(t.assignee_id)!.name}。`,
        after: (e) => setTask(e, t.id, { status: 'needs_fix', stage: 'exec', rework_count: 1 }),
      })
      turns.push({
        speaker: t.assignee_id, meta: { task_id: t.id },
        text: `已修正：第 2 段数字改为 27%，并补上了页码。`,
        before: (e) => setTask(e, t.id, { status: 'running' }),
        after: (e) => setTask(e, t.id, { status: 'done', stage: 'review' }),
      })
    }
    turns.push({
      speaker: reviewer, meta: { task_id: t.id, verdict: 'approved' },
      text: `**${t.title}：通过。** 论述清楚，引用核对无误。`,
      after: (e) => setTask(e, t.id, { status: 'done', stage: 'merge' }),
    })
  })
  turns.push({
    speaker: planner, kind: 'summary',
    text: '**汇总完成。** 三个小节已合并，统一了术语（"智能体"不再混用"代理"），全文约 3600 字。',
    after: (e) => { e.state.mode_state.tasks = e.state.mode_state.tasks!.map((t) => ({ ...t, stage: 'merge', status: 'done' })) },
  })
  return turns
}

function crossScript(room: Room, duties: Record<string, Duty>): Turn[] {
  const answerers = room.seats.filter((s) => duties[s.id] === 'answerer').map((s) => s.id)
  const judge = room.seats.find((s) => duties[s.id] === 'judge')!.id
  const label = (i: number) => `回答 ${String.fromCharCode(65 + i)}`
  const answers = [
    '约 **415 TWh**，占全球用电约 1.5%。来源：IEA《Energy and AI》，2025 年 4 月。',
    '约 **400–460 TWh**，不含加密货币挖矿。来源同为 IEA，另参考了 LBNL 的美国数据。',
    '约 **680 TWh**。（未注明具体报告，可能把加密货币挖矿和数据传输网络也算进去了。）',
  ]
  const turns: Turn[] = answerers.map((id, i) => ({
    speaker: id, meta: { phase: 'answer' }, text: pick(answers, i),
    before: (e) => { e.state.mode_state.phase = 'answer' },
  }))
  answerers.forEach((id, i) => {
    const others = answerers.map((_, j) => j).filter((j) => j !== i)
    turns.push({
      speaker: id, meta: { phase: 'review' },
      text: others.map((j) => `- **${label(j)}**：${j === 2 ? '数字明显偏高，口径可能不同，4/10' : '来源清楚，数字可信，8/10'}`).join('\n'),
      before: (e) => { e.state.mode_state.phase = 'review' },
    })
  })
  turns.push({
    speaker: judge, kind: 'verdict',
    meta: {
      phase: 'verdict',
      agreements: ['权威来源是 IEA 2025 年的报告', '数量级在 400–500 TWh 之间'],
      disagreements: ['是否计入加密货币挖矿（约 100–150 TWh）', '是否计入数据传输网络'],
    },
    text: '回答 A 和 B 一致，都来自 IEA，可信度高。回答 C 的 680 TWh 很可能是统计口径不同，而不是错误。\n\n**建议引用写法：** 约 415 TWh（IEA，不含加密货币挖矿）。',
    before: (e) => { e.state.mode_state.phase = 'verdict' },
    after: (e) => { e.state.mode_state.phase = 'done' },
  })
  return turns
}

function debateScript(room: Room, duties: Record<string, Duty>): Turn[] {
  const pro = room.seats.find((s) => duties[s.id] === 'pro')!.id
  const con = room.seats.find((s) => duties[s.id] === 'con')!.id
  const judge = room.seats.find((s) => duties[s.id] === 'judge')!.id
  const P = [
    'LiteLLM、LangGraph 这些编排库都是 Python 优先。用 Node 意味着很多能力要自己重写，或者等 JS 版本跟上。',
    'FastAPI 原生支持 WebSocket 和 SSE，流式推送几十行就能写完。类型共享可以用 OpenAPI 自动生成 TS 类型。',
    '反方说的心智负担是真的，但 AI 相关的代码占后端的大头，这部分用 Python 省下的时间远多于多学一门语言的成本。',
  ]
  const C = [
    '前端已经是 React，用 Node 能共享类型定义，WebSocket 生态也更成熟。两个人的小团队，少一种语言就少一份心智负担。',
    '自动生成类型听起来简单，实际要维护一条生成流水线。而且阿哲更熟 Node，部署和排错都会更快。',
    '如果主要价值在编排引擎，而编排引擎按方案是自己写的状态机，那 Python 生态的优势就没那么大了。',
  ]
  const scores = [58, 64, 61]
  const turns: Turn[] = []
  for (let r = 1; r <= room.rounds; r++) {
    turns.push({ speaker: pro, meta: { side: 'pro' }, text: pick(P, r - 1), before: (e) => e.setRound(r) })
    turns.push({ speaker: con, meta: { side: 'con' }, text: pick(C, r - 1) })
    turns.push({
      speaker: judge, meta: { side: 'judge' },
      text: r === 1 ? '反方的"少一种语言"有分量，但没有回答 LiteLLM 的替代方案。正方需要回应 WebSocket 的问题。' : `第 ${r} 回合：双方都回应了对方的要点，正方在"AI 代码占大头"这一点上更有说服力。`,
      after: (e) => { e.state.mode_state.score_pro = pick(scores, r - 1) },
    })
  }
  turns.push({
    speaker: judge, kind: 'verdict', meta: { side: 'judge' },
    text: '**判断：正方略胜。** 关键在于后端的主要工作量是模型调用和编排，Python 生态能省下不少时间。但反方指出的团队熟悉度问题是真实的，建议让熟悉 Node 的成员负责部署和前端，后端由熟悉 Python 的成员负责。',
  })
  return turns
}

function buildScript(room: Room, duties: Record<string, Duty>): Turn[] {
  switch (room.mode) {
    case 'round': return roundScript(room, duties, 1, room.rounds)
    case 'pipe': return pipeScript(room, duties)
    case 'cross': return crossScript(room, duties)
    case 'debate': return debateScript(room, duties)
  }
}

/* ---------------- 房间引擎 ---------------- */

class Engine {
  room: Room
  duties: Record<string, Duty>
  messages: Message[] = []
  state: RoomState
  script: Turn[]
  forced: string[] = []
  humanNote: { name: string; reply: string } | null = null
  listeners = new Set<(e: ServerEvent) => void>()
  online = new Set<string>()
  running = false
  pauseAfter = false
  cut: 'interrupt' | 'skip' | null = null
  seq = 0

  constructor(room: Room, duties: Record<string, Duty>, script?: Turn[]) {
    this.room = room
    this.duties = duties
    this.script = script ?? buildScript(room, duties)
    this.state = {
      status: 'idle', round: 0, total_rounds: room.rounds, speaker_id: null, next_speaker_id: null,
      cost_cny: 0, budget_cny: room.budget_cny, context_tokens: 0, summarized_until_round: 0, mode_state: {},
    }
    if (room.mode === 'debate') this.state.mode_state.score_pro = null
  }

  emit(e: ServerEvent) {
    const copy = clone(e)
    this.listeners.forEach((l) => setTimeout(() => l(copy), 0))
  }
  pushState() {
    this.state.next_speaker_id = this.forced[0] ?? this.script.find((t) => person(t.speaker) && 'model' in person(t.speaker)!)?.speaker ?? null
    this.state.context_tokens = Math.round(this.messages.reduce((a, m) => a + m.content.length, 0) * 1.5)
    this.room.status = this.state.status
    this.room.cost_cny = this.state.cost_cny
    this.emit({ type: 'state', state: this.state })
  }
  setRound(r: number) { this.state.round = r }

  takeHumanNote() { const n = this.humanNote; this.humanNote = null; return n }

  newMessage(author: string | null, kind: MessageKind, content: string, extra: Partial<Message> = {}): Message {
    const m: Message = {
      id: uid('m_'), seq: ++this.seq, room_id: this.room.id, author_id: author, kind, content,
      round: this.state.round, created_at: now(), mentions: [], reply_to: null, cost_cny: null,
      interrupted: false, streaming: false, meta: {}, ...extra,
    }
    this.messages.push(m)
    this.room.updated_at = m.created_at
    if (content) this.room.last_preview = `${author ? person(author)?.name : '系统'}：${content.replace(/[*#>\n]/g, ' ').slice(0, 60)}`
    return m
  }

  /** 种子数据：立即执行脚本前 n 步，不做流式 */
  fastForward(n: number) {
    for (let i = 0; i < n && this.script.length; i++) {
      const t = this.script.shift()!
      t.before?.(this)
      const text = typeof t.text === 'function' ? t.text(this) : t.text
      const isAi = !!members.find((m) => m.id === t.speaker)
      const cost = isAi ? round4(text.length * (PRICE[t.speaker] ?? 0)) : null
      const reply = t.replyTo === 'prev' ? this.messages[this.messages.length - 1]?.id ?? null : null
      this.newMessage(t.speaker, t.kind ?? 'chat', text, { cost_cny: cost, meta: t.meta ?? {}, mentions: t.mentions ?? [], reply_to: reply })
      if (cost) this.state.cost_cny = round4(this.state.cost_cny + cost)
      t.after?.(this)
    }
    this.room.cost_cny = this.state.cost_cny
    this.state.context_tokens = Math.round(this.messages.reduce((a, m) => a + m.content.length, 0) * 1.5)
  }

  /* ---- 客户端事件 ---- */
  handle(user: User, e: ClientEvent) {
    switch (e.type) {
      case 'say': {
        const m = this.newMessage(user.id, 'chat', e.content, { mentions: e.mentions })
        this.emit({ type: 'message', message: m, client_id: e.client_id })
        const ais = e.mentions.filter((id) => this.room.seats.some((s) => s.id === id && s.kind === 'ai'))
        this.forced.push(...ais)
        this.humanNote = { name: user.name, reply: `你说的"${e.content.slice(0, 24)}${e.content.length > 24 ? '……' : ''}"，我认为值得认真考虑，下面结合它继续。` }
        if (ais.length && (this.state.status === 'finished' || this.state.status === 'idle')) this.start()
        else this.pushState()
        break
      }
      case 'steer': {
        const m = this.newMessage(user.id, 'steer', e.content)
        this.emit({ type: 'message', message: m })
        break
      }
      case 'start': this.start(); break
      case 'pause':
        if (this.state.status !== 'running') return
        if (this.state.speaker_id) this.pauseAfter = true
        else { this.state.status = 'paused'; this.pushState() }
        break
      case 'resume':
        if (this.state.status !== 'paused') return
        this.state.status = 'running'; this.pushState(); void this.run()
        break
      case 'interrupt':
        if (this.state.speaker_id) this.cut = 'interrupt'
        else if (this.state.status === 'running') { this.state.status = 'paused'; this.pushState() }
        break
      case 'skip':
        if (this.state.speaker_id) this.cut = 'skip'
        break
    }
  }

  start() {
    if (this.state.status === 'running' || this.state.status === 'paused') return
    if (this.state.status === 'finished' && !this.script.length && !this.forced.length) {
      if (this.room.mode !== 'round') return this.emit({ type: 'error', code: 'mode_finished', message: '这个模式已经结束，可以新建一个房间继续' })
      const r = this.state.total_rounds + 1
      this.state.total_rounds = r
      this.room.rounds = r
      this.script = roundScript(this.room, this.duties, r, r)
    }
    if (this.state.status === 'budget_exceeded') return this.emit({ type: 'error', code: 'budget_exceeded', message: '预算已用完，请先提高房间预算' })
    this.state.status = 'running'
    this.pushState()
    void this.run()
  }

  async run() {
    if (this.running) return
    this.running = true
    try {
      while (this.state.status === 'running') {
        let turn: Turn | undefined
        if (this.forced.length) {
          const id = this.forced.shift()!
          turn = { speaker: id, text: (e) => { const n = e.takeHumanNote(); return `**回应 ${n?.name ?? '你'}：** 好的，我来回答。${n ? n.reply : ''}\n\n我的看法是先把范围缩小到一个场景，验证有效后再扩展。` } }
        } else turn = this.script.shift()
        if (!turn) {
          this.state.status = 'finished'
          this.state.speaker_id = null
          this.pushState()
          break
        }
        if (this.state.cost_cny >= this.state.budget_cny) {
          const m = this.newMessage(null, 'system', `房间预算 ¥${this.state.budget_cny.toFixed(2)} 已用完，讨论停止。`)
          this.emit({ type: 'message', message: m })
          this.script.unshift(turn)
          this.state.status = 'budget_exceeded'
          this.pushState()
          break
        }
        await this.speak(turn)
      }
    } finally {
      this.running = false
    }
  }

  async speak(t: Turn) {
    t.before?.(this)
    const full = typeof t.text === 'function' ? t.text(this) : t.text
    const msg = this.newMessage(t.speaker, t.kind ?? 'chat', '', { streaming: true, meta: t.meta ?? {} })
    this.state.speaker_id = t.speaker
    this.emit({ type: 'message_start', message: msg })
    this.pushState()

    let pos = 0
    while (pos < full.length) {
      await sleep(40)
      if (this.cut) break
      const step = 2 + Math.floor(Math.random() * 3)
      const delta = full.slice(pos, pos + step)
      pos += step
      msg.content += delta
      this.emit({ type: 'message_delta', id: msg.id, delta })
    }
    const cut = this.cut
    this.cut = null
    msg.streaming = false
    msg.interrupted = !!cut
    msg.cost_cny = round4(msg.content.length * (PRICE[t.speaker] ?? 0))
    this.state.cost_cny = round4(this.state.cost_cny + msg.cost_cny)
    if (msg.content) this.room.last_preview = `${person(t.speaker)?.name}：${msg.content.replace(/[*#>\n]/g, ' ').slice(0, 60)}`
    if (!cut) t.after?.(this)
    this.emit({ type: 'message_end', id: msg.id, content: msg.content, cost_cny: msg.cost_cny, interrupted: msg.interrupted, meta: msg.meta })
    this.state.speaker_id = null
    if (cut === 'interrupt' || this.pauseAfter) {
      this.pauseAfter = false
      this.state.status = 'paused'
    }
    this.pushState()
  }
}

/* ---------------- 种子房间 ---------------- */

const engines = new Map<string, Engine>()

function makeRoom(p: { id?: string; title: string; topic: string; mode: Room['mode']; ais: string[]; humans: string[]; rounds: number; budget: number; createdBy: string; duties?: Record<string, Duty> }) {
  const duties = assignDuties(p.mode, p.ais, p.duties)
  const room: Room = {
    id: p.id ?? uid('r_'), title: p.title, topic: p.topic, mode: p.mode, status: 'idle',
    seats: [...p.humans.map((h) => seatOf(h, null)), ...p.ais.map((a) => seatOf(a, duties[a]))],
    last_preview: '还没有发言', updated_at: now(), cost_cny: 0, budget_cny: p.budget, created_by: p.createdBy, rounds: p.rounds,
  }
  return { room, duties }
}

function seed() {
  // 1. 圆桌：前几轮已完成，正在进行
  {
    const { room, duties } = makeRoom({ id: 'r_weekend', title: '周末小程序选题：留学生工具做哪个方向', topic: '我们想两周内做一个给留学生用的小工具。三个方向：二手教材交易、合租室友匹配、作业 DDL 提醒。帮我们评一下，最后选一个。', mode: 'round', ais: ['ai_claude', 'ai_gpt', 'ai_gemini', 'ai_deepseek'], humans: ['u_lin', 'u_zhe'], rounds: 3, budget: 10, createdBy: 'u_lin', duties: { ai_claude: 'summarizer' } })
    const t: Turn[] = [
      { speaker: 'ai_claude', before: (e) => e.setRound(1), text: '我倾向 **DDL 提醒**。它是三个里唯一一个"一个人就能用起来"的产品，不依赖另一端有人。教材交易和合租都是双边市场，冷启动时没有卖家就没有买家。\n\n风险是同质化：学校自己的 Canvas 已经有提醒。差异点得放在"把所有课的 DDL 汇成一张时间线"。' },
      { speaker: 'ai_gpt', text: '从工程量看：DDL 提醒最轻，抓取 Canvas 日历 + 推送，一周能做完。教材交易要做商品、聊天、举报，两周很紧。合租匹配需要问卷和匹配算法，算法本身不难，难的是数据。' },
      { speaker: 'ai_gemini', text: '补一个用户侧的观察（这是假设，还没验证）：留学生对"省钱"的敏感度比"省时间"高，教材交易的需求可能被低估了。' },
      { speaker: 'ai_deepseek', text: '我反对前两位的结论。DDL 提醒"容易做"恰恰是问题：容易做就意味着已经有人做了，Notion 模板、iOS 提醒事项都能顶上。两周后拿出去，用户凭什么换？\n\n至少一个问题必须回答：**留学生现在用什么解决 DDL，痛在哪？**' },
      { speaker: 'u_zhe', text: '@DeepSeek 说得有道理。那你觉得合租匹配风险具体在哪？我们宿舍群里每学期都有人找室友。', mentions: ['ai_deepseek'], replyTo: 'prev', before: (e) => e.setRound(2) },
      { speaker: 'ai_deepseek', text: '合租的风险在信任和责任。匹配错了，用户损失的是一年的租约，不是一个 App。出了纠纷谁负责？两周的小工具扛不起这个。' },
      { speaker: 'ai_gemini', text: '如果只有两周，我会先砍掉合租匹配。它的价值在信任，而信任在两周里建立不起来。\n\n我更想补一个数据：上学期我们在两个留学生群里问过，最常见的抱怨不是"忘了 DDL"，而是"不同课的 DDL 散在三个平台"。所以 Claude 说的"一张时间线"是对的方向，但它得能自动抓 Canvas、Gradescope 和邮件，否则就是另一个手动待办。' },
    ]
    const rest = roundScript(room, duties, 2, 3)
    t.push(...rest.slice(0, 2), ...rest.slice(4))
    const e = new Engine(room, duties, t)
    e.fastForward(7)
    e.state.status = 'running'
    e.room.status = 'running'
    engines.set(room.id, e)
  }
  // 2. 流水线：未开始，点"开始"即可观看
  {
    const { room, duties } = makeRoom({ id: 'r_thesis', title: '论文第三章：近五年多智能体协作文献综述', topic: '写论文第三章：近五年多智能体协作文献综述，约 6000 字，引用必须来自知识库。', mode: 'pipe', ais: ['ai_claude', 'ai_deepseek', 'ai_qwen', 'ai_llama', 'ai_gpt'], humans: ['u_yu', 'u_lin'], rounds: 2, budget: 10, createdBy: 'u_yu' })
    engines.set(room.id, new Engine(room, duties))
  }
  // 3. 交叉验证：已结束
  {
    const { room, duties } = makeRoom({ id: 'r_energy', title: '2024 年全球数据中心耗电量到底是多少', topic: '2024 年全球数据中心的耗电量是多少？请给出数字和来源。', mode: 'cross', ais: ['ai_gpt', 'ai_gemini', 'ai_deepseek', 'ai_claude'], humans: ['u_kai', 'u_lin'], rounds: 1, budget: 5, createdBy: 'u_kai' })
    const e = new Engine(room, duties)
    e.state.status = 'finished'
    e.fastForward(99)
    e.room.status = 'finished'
    engines.set(room.id, e)
  }
  // 4. 辩论：第 1 回合已完成，暂停中
  {
    const { room, duties } = makeRoom({ id: 'r_backend', title: '后端用 FastAPI 还是 Node', topic: 'Roundtable 的后端应该用 Python FastAPI', mode: 'debate', ais: ['ai_gpt', 'ai_deepseek', 'ai_claude'], humans: ['u_lin', 'u_zhe'], rounds: 3, budget: 5, createdBy: 'u_lin' })
    const e = new Engine(room, duties)
    e.fastForward(3)
    e.state.status = 'paused'
    e.room.status = 'paused'
    engines.set(room.id, e)
  }
}
seed()
// 让正在进行的种子房间继续跑
engines.forEach((e) => { if (e.state.status === 'running') void e.run() })

/* ---------------- 邀请码 ---------------- */

const INVITE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
let invites: Invite[] = [
  { code: 'RT7K2M', note: '给凯文', created_at: new Date(Date.now() - 2 * 86400000).toISOString(), expires_at: new Date(Date.now() + 5 * 86400000).toISOString(), used_by: 'u_kai' },
]
function requireAdmin(): User {
  const u = currentUser()
  if (!u.is_admin) throw new ApiError(403, 'forbidden', '只有管理员可以这样做')
  return u
}

/* ---------------- Api 实现 ---------------- */

const delay = async <T>(v: T, ms = 120): Promise<T> => { await sleep(ms); return clone(v) }
const summary = (r: Room): RoomSummary => {
  const { topic: _t, rounds: _r, ...rest } = r
  return rest
}

export const mockApi: Api = {
  async login(code, name) {
    if (code.trim().length !== 6) throw new ApiError(400, 'invalid_code', '邀请码是 6 位')
    let u = users.find((x) => x.name === name.trim())
    if (!u) {
      const colors = ['#FFE3B3', '#D6ECFF', '#E0F5E4', '#F6E0FA', '#FFE0E0']
      u = { id: uid('u_'), name: name.trim(), short: name.trim().slice(0, 1), color: colors[users.length % colors.length], is_admin: false, monthly_limit_cny: 100 }
      users.push(u)
    }
    localStorage.setItem('rt_mock_user', u.id)
    return delay(u)
  },
  async me() { return delay(currentUser(), 30) },
  async logout() { localStorage.removeItem('rt_mock_user') },
  async users() { return delay(users) },
  async models() { return delay(models) },
  async members() { return delay(members) },
  async createMember(input) {
    const m: AiMember = { ...input, id: uid('ai_'), month_cost_cny: 0 }
    members.push(m)
    return delay(m)
  },
  async updateMember(id, patch) {
    const i = members.findIndex((m) => m.id === id)
    if (i < 0) throw new ApiError(404, 'not_found', '成员不存在')
    members[i] = { ...members[i], ...patch }
    return delay(members[i])
  },
  async deleteMember(id) { members = members.filter((m) => m.id !== id) },
  async rooms() {
    currentUser()
    const list = [...engines.values()].map((e) => summary(e.room)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    return delay(list)
  },
  async room(id) {
    const e = engines.get(id)
    if (!e) throw new ApiError(404, 'not_found', '房间不存在')
    return delay(e.room)
  },
  async createRoom(input: CreateRoomInput) {
    const me = currentUser()
    const n = input.ai_member_ids.length
    if (n < 2) throw new ApiError(400, 'invalid_members', '至少选择 2 个模型')
    const duties = assignDuties(input.mode, input.ai_member_ids, input.duties)
    if (input.mode === 'debate' && !['pro', 'con', 'judge'].every((d) => Object.values(duties).includes(d as Duty))) throw new ApiError(400, 'invalid_duties', '辩论需要正方、反方和裁判至少各一位')
    if (input.mode === 'cross' && !Object.values(duties).includes('judge')) throw new ApiError(400, 'invalid_duties', '交叉验证需要一位主席')
    if (input.mode === 'pipe' && !Object.values(duties).includes('planner')) throw new ApiError(400, 'invalid_duties', '流水线需要一位规划者')
    const { room } = makeRoom({
      title: input.title?.trim() || input.topic.trim().slice(0, 30), topic: input.topic.trim(), mode: input.mode,
      ais: input.ai_member_ids, humans: [me.id, ...input.human_user_ids.filter((h) => h !== me.id)],
      rounds: input.rounds, budget: input.budget_cny, createdBy: me.id, duties,
    })
    const e = new Engine(room, duties)
    engines.set(room.id, e)
    if (input.auto_start) setTimeout(() => e.start(), 600)
    return delay(room)
  },
  async deleteRoom(id) { engines.delete(id) },
  async usage(range) {
    let seed = 7
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    const days = range === 'week' ? 7 : range === 'month' ? 22 : 60
    const weights: Record<string, number> = { ai_claude: 2.2, ai_gpt: 1.4, ai_gemini: 0.9, ai_deepseek: 0.4, ai_qwen: 0.3 }
    const by_day: Usage['by_day'] = []
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000)
      const wk = d.getDay() === 0 || d.getDay() === 6 ? 1.6 : 1
      const by_member: Record<string, number> = {}
      for (const k in weights) by_member[k] = round4(weights[k] * (0.3 + rnd() * 1.4) * wk)
      by_day.push({ date: d.toISOString().slice(0, 10), by_member })
    }
    const total = by_day.reduce((a, d) => a + Object.values(d.by_member).reduce((x, y) => x + y, 0), 0)
    const share = [0.3, 0.33, 0.26, 0.11]
    const rooms = [...engines.values()].map((e) => e.room).sort((a, b) => b.cost_cny - a.cost_cny).slice(0, 5)
    return delay<Usage>({
      range, total_cny: round4(total), team_budget_cny: range === 'month' ? 300 : null,
      tokens_in: Math.round(total * 12000), tokens_out: Math.round(total * 4500),
      by_day,
      by_user: users.map((u, i) => ({ user_id: u.id, cost_cny: round4(total * (share[i] ?? 0.02)), limit_cny: u.monthly_limit_cny })),
      by_room: rooms.map((r) => ({ room_id: r.id, title: r.title, mode: r.mode, cost_cny: r.cost_cny, budget_cny: r.budget_cny })),
    })
  },

  async invites() { requireAdmin(); return delay(invites) },
  async createInvite(note) {
    requireAdmin()
    const code = Array.from({ length: 6 }, () => INVITE_CHARS[Math.floor(Math.random() * INVITE_CHARS.length)]).join('')
    const inv: Invite = { code, note: note.trim(), created_at: now(), expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), used_by: null }
    invites = [inv, ...invites]
    return delay(inv)
  },
  async revokeInvite(code) {
    requireAdmin()
    const inv = invites.find((i) => i.code === code.toUpperCase())
    if (!inv) throw new ApiError(404, 'not_found', '邀请码不存在')
    if (inv.used_by) throw new ApiError(400, 'invite_used', '已使用的邀请码不能作废')
    invites = invites.filter((i) => i !== inv)
  },

  connectRoom(roomId: string, opts: ConnectOptions): RoomConnection {
    const e = engines.get(roomId)
    let closed = false
    let user: User
    try { user = currentUser() } catch {
      setTimeout(() => opts.onStatus('closed', '登录已过期，请重新登录'), 0)
      return { send() {}, close() {} }
    }
    if (!e) {
      setTimeout(() => opts.onStatus('closed', '房间不存在'), 0)
      return { send() {}, close() {} }
    }
    const listener = (ev: ServerEvent) => { if (!closed) opts.onEvent(ev) }
    opts.onStatus('connecting')
    setTimeout(() => {
      if (closed) return
      e.listeners.add(listener)
      e.online.add(user.id)
      opts.onStatus('open')
      // 真实客户端在连接打开时发 hello；这里直接按 lastSeq 回 snapshot
      const msgs = e.messages.filter((m) => m.seq > opts.lastSeq())
      listener(clone({ type: 'snapshot', messages: msgs, state: e.state, online: [...e.online] }))
      e.emit({ type: 'presence', online: [...e.online] })
    }, 150)
    return {
      send(ev) {
        if (closed) return
        if (ev.type === 'hello') return
        setTimeout(() => e.handle(user, ev), 60)
      },
      close() {
        closed = true
        e.listeners.delete(listener)
        e.online.delete(user.id)
        e.emit({ type: 'presence', online: [...e.online] })
      },
    }
  },
}
