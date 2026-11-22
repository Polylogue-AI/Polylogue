import type { Duty, Mode, RoomStatus } from './api'

export const MODE_NAME: Record<Mode, string> = { round: '圆桌讨论', pipe: '分工流水线', cross: '交叉验证', debate: '辩论' }
export const MODE_DESC: Record<Mode, string> = {
  round: '轮流发言、互相反驳，最后汇总成结论',
  pipe: '规划、执行、审查、汇总，各司其职',
  cross: '同一个问题问几家，互评后由主席标出分歧',
  debate: '正反双方对辩，帮你找到方案漏洞',
}
export const MODE_FIT: Record<Mode, string> = {
  round: '适合方案评审、选题、头脑风暴',
  pipe: '适合写代码、写长文档、做调研',
  cross: '适合事实核查、挑出最佳答案',
  debate: '适合做决策、找方案的漏洞',
}

export const DUTY_NAME: Record<Duty, string> = {
  speaker: '发言者', summarizer: '汇总者',
  planner: '规划者', executor: '执行者', reviewer: '审查者',
  answerer: '回答者', judge: '裁判',
  pro: '正方', con: '反方',
}
export const MODE_DUTIES: Record<Mode, Duty[]> = {
  round: ['speaker', 'summarizer'],
  pipe: ['planner', 'executor', 'reviewer'],
  cross: ['answerer', 'judge'],
  debate: ['pro', 'con', 'judge'],
}

export const STATUS_NAME: Record<RoomStatus, string> = {
  idle: '未开始', running: '进行中', paused: '已暂停', finished: '已结束', budget_exceeded: '预算用完', error: '出错',
}

/** 与契约"职责自动分配规则"一致，用于新建房间时的默认值 */
export function defaultDuties(mode: Mode, ids: string[]): Record<string, Duty> {
  const d: Record<string, Duty> = {}
  const n = ids.length
  ids.forEach((id, i) => {
    if (mode === 'round') d[id] = 'speaker'
    if (mode === 'pipe') d[id] = n === 2 ? (i === 0 ? 'planner' : 'executor') : i === 0 ? 'planner' : i === n - 1 ? 'reviewer' : 'executor'
    if (mode === 'cross') d[id] = i === n - 1 ? 'judge' : 'answerer'
    if (mode === 'debate') d[id] = i === n - 1 ? 'judge' : i % 2 === 0 ? 'pro' : 'con'
  })
  return d
}

export const yuan = (n: number | null | undefined, digits = 2) => (n == null ? '—' : `¥${n.toFixed(digits)}`)

export function timeAgo(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86400 * 2) return '昨天'
  return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}
