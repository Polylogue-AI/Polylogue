import { useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, USE_MOCK } from '../api'
import { useSession } from '../state/session'
import { Avatar } from './Avatar'
import { BrandMark, Icon } from './Icon'
import { NewRoomSheet } from './NewRoomSheet'
import type { Mode } from '../api'

export function Layout() {
  const { user, rooms, setUser } = useSession()
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState<Mode | null>(null)
  const nav = useNavigate()
  const loc = useLocation()
  const live = rooms.filter((r) => r.status === 'running' || r.status === 'paused' || r.status === 'idle')

  const title = loc.pathname.startsWith('/members') ? '成员' : loc.pathname.startsWith('/usage') ? '用量与费用' : loc.pathname.startsWith('/settings') ? '设置' : '房间'

  return (
    <div className="app">
      <aside className={`sidebar ${open ? 'open' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('a,button')) setOpen(false) }}>
        <div className="brand"><BrandMark /><b>Polylogue</b></div>
        <NavLink className="nav-item" to="/rooms" end aria-current={loc.pathname === '/rooms' ? 'page' : undefined}>
          <Icon name="rooms" size={17} />房间<span className="count">{rooms.length}</span>
        </NavLink>
        <NavLink className="nav-item" to="/members" aria-current={loc.pathname.startsWith('/members') ? 'page' : undefined}>
          <Icon name="members" size={17} />成员
        </NavLink>
        <NavLink className="nav-item" to="/usage" aria-current={loc.pathname.startsWith('/usage') ? 'page' : undefined}>
          <Icon name="chart" size={17} />用量与费用
        </NavLink>
        <NavLink className="nav-item" to="/settings" aria-current={loc.pathname.startsWith('/settings') ? 'page' : undefined}>
          <Icon name="gear" size={17} />设置
        </NavLink>

        <div className="side-group">
          进行中的房间
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={() => setSheet('round')} aria-label="新建房间"><Icon name="plus" size={15} /></button>
        </div>
        {live.map((r) => {
          const current = loc.pathname === `/rooms/${r.id}`
          return (
            <NavLink key={r.id} to={`/rooms/${r.id}`} className="nav-item room-link" aria-current={current ? 'page' : undefined}>
              <span className="dot" style={{ background: r.seats.find((s) => s.kind === 'ai')?.color ?? 'var(--ink-3)' }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.title}</span>
              {r.status === 'running' && <span className="live" title="正在进行" />}
            </NavLink>
          )
        })}

        {user && (
          <div className="side-foot">
            <Avatar name={user.name} short={user.short} color={user.color} kind="human" />
            <div className="meta">
              <b>{user.name}</b>
              <span className="faint">{user.is_admin ? '管理员' : '成员'}{USE_MOCK ? '，模拟模式' : ''}</span>
            </div>
            <button className="icon-btn" style={{ marginLeft: 'auto' }} aria-label="退出登录" title="退出登录"
              onClick={async () => { await api.logout(); setUser(null); nav('/login') }}>
              <Icon name="logout" size={16} />
            </button>
          </div>
        )}
      </aside>

      <main className="main">
        <div className="mobile-bar">
          <button className="icon-btn" onClick={() => setOpen((o) => !o)} aria-label="打开菜单"><Icon name="menu" /></button>
          <b>{title}</b>
        </div>
        <Outlet context={{ openSheet: (m: Mode) => setSheet(m) }} />
      </main>

      {sheet && <NewRoomSheet initialMode={sheet} onClose={() => setSheet(null)} />}
    </div>
  )
}

export interface LayoutContext { openSheet(mode: Mode): void }
