import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, type AiMember, type RoomSummary, type User } from '../api'

interface Session {
  user: User | null
  loading: boolean
  users: User[]
  members: AiMember[]
  rooms: RoomSummary[]
  setUser(u: User | null): void
  refresh(): Promise<void>
  refreshRooms(): Promise<void>
  /** 根据 ID 找人或 AI，用于头像和名字 */
  who(id: string | null): { name: string; short: string; color: string; kind: 'human' | 'ai'; role?: string } | null
}

const Ctx = createContext<Session | null>(null)

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [users, setUsers] = useState<User[]>([])
  const [members, setMembers] = useState<AiMember[]>([])
  const [rooms, setRooms] = useState<RoomSummary[]>([])

  const refreshRooms = useCallback(async () => { setRooms(await api.rooms()) }, [])
  const refresh = useCallback(async () => {
    const [u, m, r] = await Promise.all([api.users(), api.members(), api.rooms()])
    setUsers(u); setMembers(m); setRooms(r)
  }, [])

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setLoading(false))
  }, [])
  useEffect(() => { if (user) refresh().catch(() => {}) }, [user, refresh])

  const who = useCallback<Session['who']>((id) => {
    if (!id) return null
    const u = users.find((x) => x.id === id)
    if (u) return { name: u.name, short: u.short, color: u.color, kind: 'human' }
    const m = members.find((x) => x.id === id)
    if (m) return { name: m.name, short: m.short, color: m.color, kind: 'ai', role: m.role }
    for (const r of rooms) {
      const s = r.seats.find((x) => x.id === id)
      if (s) return { name: s.name, short: s.short, color: s.color, kind: s.kind, role: s.role ?? undefined }
    }
    return null
  }, [users, members, rooms])

  const value = useMemo(() => ({ user, loading, users, members, rooms, setUser, refresh, refreshRooms, who }), [user, loading, users, members, rooms, refresh, refreshRooms, who])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useSession() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession 必须在 SessionProvider 里使用')
  return s
}
