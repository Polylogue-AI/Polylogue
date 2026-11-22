import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { api, type ClientEvent, type ConnStatus, type Room } from '../api'
import { emptyRoom, roomReducer } from './roomReducer'
import { useSession } from './session'
import { useToast } from './toast'

export function useRoom(roomId: string) {
  const { user, refreshRooms } = useSession()
  const toast = useToast()
  const [room, setRoom] = useState<Room | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [view, dispatch] = useReducer(roomReducer, emptyRoom)
  const [conn, setConn] = useState<{ status: ConnStatus; reason?: string }>({ status: 'connecting' })
  const seqRef = useRef(0)
  seqRef.current = view.lastSeq
  const connRef = useRef<ReturnType<typeof api.connectRoom> | null>(null)

  useEffect(() => {
    let alive = true
    dispatch({ type: 'reset' })
    seqRef.current = 0
    setRoom(null)
    setLoadError(null)
    api.room(roomId).then((r) => alive && setRoom(r)).catch((e) => alive && setLoadError(e.message))
    const c = api.connectRoom(roomId, {
      lastSeq: () => seqRef.current,
      onStatus: (status, reason) => alive && setConn({ status, reason }),
      onEvent: (e) => {
        if (!alive) return
        if (e.type === 'error') toast(e.message)
        dispatch(e)
      },
    })
    connRef.current = c
    return () => {
      alive = false
      c.close()
      connRef.current = null
      refreshRooms().catch(() => {})
    }
  }, [roomId, toast, refreshRooms])

  const send = useCallback((e: ClientEvent) => connRef.current?.send(e), [])

  const say = useCallback((content: string, mentions: string[]) => {
    if (!user) return
    const client_id = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    dispatch({ type: 'local_pending', pending: { client_id, content, author_id: user.id, created_at: new Date().toISOString() } })
    send({ type: 'say', content, mentions, client_id })
  }, [user, send])

  return { room, loadError, ...view, conn, send, say }
}
