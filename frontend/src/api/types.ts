// 与 docs/03-接口契约.md v0.5 逐字段对应。两者冲突时以契约为准。

export interface Invite {
  code: string
  note: string
  created_at: string
  expires_at: string
  used_by: string | null
}

export type Mode = 'round' | 'pipe' | 'cross' | 'debate'

export interface User {
  id: string
  name: string
  short: string
  color: string
  is_admin: boolean
  monthly_limit_cny: number | null
}

export interface AiMember {
  id: string
  name: string
  short: string
  color: string
  model: string
  role: string
  system_prompt: string
  temperature: number
  max_chars: number | null
  monthly_budget_cny: number | null
  can_mention: boolean
  month_cost_cny: number
}
export type AiMemberInput = Omit<AiMember, 'id' | 'month_cost_cny'>

export interface ModelOption {
  id: string
  label: string
  provider: string
  available: boolean
  supports_temperature: boolean  // false 时成员页禁用温度滑杆（契约 v0.5）
}

export type Duty =
  | 'speaker' | 'summarizer'
  | 'planner' | 'executor' | 'reviewer'
  | 'answerer' | 'judge'
  | 'pro' | 'con'

export interface Seat {
  id: string
  kind: 'human' | 'ai'
  name: string
  short: string
  color: string
  duty: Duty | null
  role: string | null
}

export type RoomStatus = 'idle' | 'running' | 'paused' | 'finished' | 'budget_exceeded' | 'error'

export interface RoomSummary {
  id: string
  title: string
  mode: Mode
  status: RoomStatus
  seats: Seat[]
  last_preview: string
  updated_at: string
  cost_cny: number
  budget_cny: number
  created_by: string
}

export interface Room extends RoomSummary {
  topic: string
  rounds: number
}

export interface PipeTask {
  id: string
  stage: 'plan' | 'exec' | 'review' | 'merge'
  title: string
  assignee_id: string
  status: 'queued' | 'running' | 'done' | 'needs_fix'
  rework_count: number
}

export interface ModeState {
  tasks?: PipeTask[]
  phase?: 'answer' | 'review' | 'verdict' | 'done'
  score_pro?: number | null
}

export interface RoomState {
  status: RoomStatus
  round: number
  total_rounds: number
  speaker_id: string | null
  next_speaker_id: string | null
  cost_cny: number
  budget_cny: number
  context_tokens: number
  summarized_until_round: number
  mode_state: ModeState
}

export type MessageKind = 'chat' | 'summary' | 'verdict' | 'steer' | 'system'

export interface MessageMeta {
  task_id?: string
  verdict?: 'approved' | 'needs_fix'
  phase?: 'answer' | 'review' | 'verdict'
  anon_label?: string
  side?: 'pro' | 'con' | 'judge'
  agreements?: string[]
  disagreements?: string[]
}

export interface Message {
  id: string
  seq: number
  room_id: string
  author_id: string | null
  kind: MessageKind
  content: string
  round: number
  created_at: string
  mentions: string[]
  reply_to: string | null
  cost_cny: number | null
  interrupted: boolean
  streaming: boolean
  meta: MessageMeta
}

export interface CreateRoomInput {
  topic: string
  title?: string
  mode: Mode
  ai_member_ids: string[]
  human_user_ids: string[]
  duties?: Record<string, Duty>
  rounds: number
  budget_cny: number
  auto_start: boolean
}

export type UsageRange = 'week' | 'month' | 'all'
export interface Usage {
  range: UsageRange
  total_cny: number
  team_budget_cny: number | null
  tokens_in: number
  tokens_out: number
  by_day: { date: string; by_member: Record<string, number> }[]
  by_user: { user_id: string; cost_cny: number; limit_cny: number | null }[]
  by_room: { room_id: string; title: string; mode: Mode; cost_cny: number; budget_cny: number }[]
}

export type ClientEvent =
  | { type: 'hello'; last_seq: number }
  | { type: 'say'; content: string; mentions: string[]; client_id: string }
  | { type: 'steer'; content: string }
  | { type: 'start' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'interrupt' }
  | { type: 'skip' }

export type ServerEvent =
  | { type: 'snapshot'; messages: Message[]; state: RoomState; online: string[] }
  | { type: 'state'; state: RoomState }
  | { type: 'message'; message: Message; client_id?: string }
  | { type: 'message_start'; message: Message }
  | { type: 'message_delta'; id: string; delta: string }
  | { type: 'message_end'; id: string; content: string; cost_cny: number | null; interrupted: boolean; meta?: MessageMeta }
  | { type: 'presence'; online: string[] }
  | { type: 'error'; code: string; message: string }

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}
