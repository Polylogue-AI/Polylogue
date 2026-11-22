import type { Message, RoomState, ServerEvent } from '../api'

export interface Pending { client_id: string; content: string; author_id: string; created_at: string }

export interface RoomView {
  messages: Message[]
  state: RoomState | null
  online: string[]
  pending: Pending[]
  lastSeq: number
}

export const emptyRoom: RoomView = { messages: [], state: null, online: [], pending: [], lastSeq: 0 }

type Action = ServerEvent | { type: 'local_pending'; pending: Pending } | { type: 'reset' }

function upsert(list: Message[], m: Message): Message[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i < 0) return [...list, m].sort((a, b) => a.seq - b.seq)
  const copy = list.slice()
  copy[i] = m
  return copy
}

/**
 * 重连时发给后端的 last_seq：从头数起、连续已完成的最大 seq（契约 3.1）。
 * 不能用收到的最大 seq：一条发言还在输出时断线，它在重连前结束的话，
 * 后端只补 seq 更大的消息，这条就会永远停在半截。
 */
function completedSeq(list: Message[]): number {
  let seq = 0
  for (const m of list) {
    if (m.streaming) break
    seq = m.seq
  }
  return seq
}

function withMessages(s: RoomView, messages: Message[]): RoomView {
  return { ...s, messages, lastSeq: completedSeq(messages) }
}

export function roomReducer(s: RoomView, a: Action): RoomView {
  switch (a.type) {
    case 'reset':
      return emptyRoom
    case 'local_pending':
      return { ...s, pending: [...s.pending, a.pending] }
    case 'snapshot': {
      let messages = s.messages
      for (const m of a.messages) messages = upsert(messages, m)
      return { ...withMessages(s, messages), state: a.state, online: a.online }
    }
    case 'state':
      return { ...s, state: a.state }
    case 'presence':
      return { ...s, online: a.online }
    case 'message':
    case 'message_start':
      return {
        ...withMessages(s, upsert(s.messages, a.message)),
        pending: a.type === 'message' && a.client_id ? s.pending.filter((p) => p.client_id !== a.client_id) : s.pending,
      }
    case 'message_delta':
      return { ...s, messages: s.messages.map((m) => (m.id === a.id ? { ...m, content: m.content + a.delta } : m)) }
    case 'message_end':
      return withMessages(
        s,
        s.messages.map((m) =>
          m.id === a.id ? { ...m, content: a.content, cost_cny: a.cost_cny, interrupted: a.interrupted, streaming: false, meta: a.meta ?? m.meta } : m,
        ),
      )
    case 'error':
      return s
  }
}
