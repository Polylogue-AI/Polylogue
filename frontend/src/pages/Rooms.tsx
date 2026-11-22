import { useEffect, useState } from 'react'
import { useNavigate, useOutletContext } from 'react-router-dom'
import type { Mode, RoomSummary } from '../api'
import { Avatar } from '../components/Avatar'
import { ModeGlyph, Icon } from '../components/Icon'
import type { LayoutContext } from '../components/Layout'
import { MODE_DESC, MODE_NAME, STATUS_NAME, timeAgo, yuan } from '../labels'
import { useSession } from '../state/session'

const MODES: Mode[] = ['round', 'pipe', 'cross', 'debate']
type Filter = 'active' | 'done' | 'all'

export function RoomsPage() {
  const { user, rooms, refreshRooms } = useSession()
  const { openSheet } = useOutletContext<LayoutContext>()
  const nav = useNavigate()
  const [filter, setFilter] = useState<Filter>('all')

  // 房间列表每 5 秒刷新一次，让"正在进行"的预览保持新鲜
  useEffect(() => {
    refreshRooms().catch(() => {})
    const t = setInterval(() => refreshRooms().catch(() => {}), 5000)
    return () => clearInterval(t)
  }, [refreshRooms])

  const live = rooms.find((r) => r.status === 'running')
  const hour = new Date().getHours()
  const hello = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const shown = rooms.filter((r) => filter === 'all' || (filter === 'done' ? r.status === 'finished' : r.status !== 'finished'))

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <div>
            <h1>{hello}，{user?.name}</h1>
            <p>{live ? `「${live.title}」正在进行，${live.seats.filter((s) => s.kind === 'ai').length} 个模型在桌上。` : '现在没有正在进行的讨论，开一个新房间吧。'}</p>
          </div>
          <button className="btn btn-ink" onClick={() => openSheet('round')}><Icon name="plus" size={15} />新建房间</button>
        </div>

        <div className="rooms-hero">
          {live ? <LiveCard room={live} onOpen={() => nav(`/rooms/${live.id}`)} /> : (
            <button className="live-room" onClick={() => openSheet('round')}>
              <span className="state">没有进行中的房间</span>
              <h2>把一个问题交给几个模型和朋友一起想</h2>
              <p className="quote">点这里新建房间。</p>
            </button>
          )}
          <div className="quick-start">
            {MODES.map((m) => (
              <button className="mode-tile" key={m} onClick={() => openSheet(m)}>
                <span className="glyph"><ModeGlyph mode={m} /></span>
                <div><b>{MODE_NAME[m]}</b><span>{MODE_DESC[m]}</span></div>
              </button>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '40px 0 14px' }}>
          <h2 className="section-title" style={{ margin: 0 }}>全部房间</h2>
          <div className="seg" role="group" aria-label="筛选房间">
            {(['all', 'active', 'done'] as Filter[]).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{{ all: '全部', active: '进行中', done: '已结束' }[f]}</button>
            ))}
          </div>
        </div>
        <div className="room-grid">
          {shown.map((r) => (
            <button key={r.id} className="room-card" onClick={() => nav(`/rooms/${r.id}`)}>
              <div className="top"><span className="mode-chip">{MODE_NAME[r.mode]}</span><span className="faint" style={{ fontSize: 12 }}>{r.status === 'running' ? '正在进行' : `${STATUS_NAME[r.status]} · ${timeAgo(r.updated_at)}`}</span></div>
              <h3>{r.title}</h3>
              <p className="last">{r.last_preview}</p>
              <div className="foot">
                <div className="stack">{r.seats.map((s) => <Avatar key={s.id} {...s} size="sm" />)}</div>
                <span className="num">{yuan(r.cost_cny)}</span>
              </div>
            </button>
          ))}
          {!shown.length && <p className="faint">这里还没有房间。</p>}
        </div>
      </div>
    </section>
  )
}

function LiveCard({ room, onOpen }: { room: RoomSummary; onOpen(): void }) {
  return (
    <button className="live-room" onClick={onOpen}>
      <span className="state"><i />正在进行 · {MODE_NAME[room.mode]}</span>
      <h2>{room.title}</h2>
      <div className="seats">{room.seats.map((s) => <Avatar key={s.id} {...s} />)}</div>
      <p className="quote" style={{ marginTop: 28 }}>{room.last_preview}</p>
    </button>
  )
}
