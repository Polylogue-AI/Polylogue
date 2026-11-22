import type {
  AiMember, AiMemberInput, ClientEvent, CreateRoomInput, Invite, ModelOption, Room, RoomSummary,
  ServerEvent, Usage, UsageRange, User,
} from './types'
import { ApiError } from './types'

export type ConnStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface RoomConnection {
  send(e: ClientEvent): void
  close(): void
}

export interface ConnectOptions {
  onEvent(e: ServerEvent): void
  onStatus(s: ConnStatus, reason?: string): void
  /** 每次（重）连接时调用，取前端已收到的最大 seq */
  lastSeq(): number
}

export interface Api {
  login(invite_code: string, name: string): Promise<User>
  me(): Promise<User>
  logout(): Promise<void>
  users(): Promise<User[]>
  models(): Promise<ModelOption[]>
  members(): Promise<AiMember[]>
  createMember(input: AiMemberInput): Promise<AiMember>
  updateMember(id: string, patch: Partial<AiMemberInput>): Promise<AiMember>
  deleteMember(id: string): Promise<void>
  rooms(): Promise<RoomSummary[]>
  room(id: string): Promise<Room>
  createRoom(input: CreateRoomInput): Promise<Room>
  deleteRoom(id: string): Promise<void>
  usage(range: UsageRange): Promise<Usage>
  invites(): Promise<Invite[]>
  createInvite(note: string): Promise<Invite>
  revokeInvite(code: string): Promise<void>
  connectRoom(roomId: string, opts: ConnectOptions): RoomConnection
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => null)
  if (!res.ok) {
    const err = data?.error
    throw new ApiError(res.status, err?.code ?? 'http_error', err?.message ?? `请求失败（${res.status}）`)
  }
  return data as T
}

function connectWs(roomId: string, opts: ConnectOptions): RoomConnection {
  let ws: WebSocket | null = null
  let closedByUser = false
  let attempt = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const outbox: ClientEvent[] = []

  const open = () => {
    opts.onStatus(attempt === 0 ? 'connecting' : 'reconnecting')
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/ws/rooms/${encodeURIComponent(roomId)}`)
    ws.onopen = () => {
      attempt = 0
      ws!.send(JSON.stringify({ type: 'hello', last_seq: opts.lastSeq() } satisfies ClientEvent))
      while (outbox.length) ws!.send(JSON.stringify(outbox.shift()))
      opts.onStatus('open')
    }
    ws.onmessage = (ev) => {
      try { opts.onEvent(JSON.parse(ev.data) as ServerEvent) } catch { /* 忽略无法解析的帧 */ }
    }
    ws.onclose = (ev) => {
      ws = null
      if (closedByUser) return
      if (ev.code === 4401) return opts.onStatus('closed', '登录已过期，请重新登录')
      if (ev.code === 4404) return opts.onStatus('closed', '房间不存在')
      attempt++
      opts.onStatus('reconnecting')
      timer = setTimeout(open, Math.min(1000 * 2 ** (attempt - 1), 10000))
    }
  }
  open()

  return {
    send(e) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e))
      else outbox.push(e)
    },
    close() {
      closedByUser = true
      clearTimeout(timer)
      ws?.close()
    },
  }
}

export const httpApi: Api = {
  login: (invite_code, name) => req('POST', '/api/auth/login', { invite_code, name }),
  me: () => req('GET', '/api/auth/me'),
  logout: () => req('POST', '/api/auth/logout'),
  users: () => req('GET', '/api/users'),
  models: () => req('GET', '/api/models'),
  members: () => req('GET', '/api/members'),
  createMember: (input) => req('POST', '/api/members', input),
  updateMember: (id, patch) => req('PATCH', `/api/members/${id}`, patch),
  deleteMember: (id) => req('DELETE', `/api/members/${id}`),
  rooms: () => req('GET', '/api/rooms'),
  room: (id) => req('GET', `/api/rooms/${id}`),
  createRoom: (input) => req('POST', '/api/rooms', input),
  deleteRoom: (id) => req('DELETE', `/api/rooms/${id}`),
  usage: (range) => req('GET', `/api/usage?range=${range}`),
  invites: () => req('GET', '/api/invites'),
  createInvite: (note) => req('POST', '/api/invites', { note }),
  revokeInvite: (code) => req('DELETE', `/api/invites/${encodeURIComponent(code)}`),
  connectRoom: connectWs,
}
