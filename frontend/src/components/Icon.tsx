import type { CSSProperties } from 'react'

const P: Record<string, string> = {
  rooms: 'M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM12 2v3M22 12h-3M12 22v-3M2 12h3',
  members: 'M3 4h8v8H3zM17 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM3 20c0-2.5 2-4 4.5-4h1M13 20c0-2.5 1.8-4 4-4s4 1.5 4 4',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  plus: 'M12 5v14M5 12h14',
  send: 'M12 19V5M5 12l7-7 7 7',
  pause: 'M9 5v14M15 5v14',
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6 6h12v12H6z',
  skip: 'M5 5l10 7-10 7zM19 5v14',
  steer: 'M4 17c4 0 5-10 9-10h7M16 3l4 4-4 4',
  back: 'M15 5l-7 7 7 7',
  x: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 7h16M4 12h16M4 17h16',
  spark: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  warn: 'M12 3 2 20h20zM12 10v4M12 17v.5',
  gear: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1',
}

export function Icon({ name, size = 18, style }: { name: string; size?: number; style?: CSSProperties }) {
  return (
    <svg className="i" width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d={P[name]} />
    </svg>
  )
}

export function ModeGlyph({ mode, size = 26 }: { mode: string; size?: number }) {
  const s = { width: size, height: size }
  const line = { stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }
  if (mode === 'round')
    return (
      <svg viewBox="0 0 40 40" style={s} fill="currentColor" aria-hidden>
        <circle cx="20" cy="20" r="8" fill="none" stroke="currentColor" strokeWidth="1.6" />
        <circle cx="20" cy="6" r="3" /><circle cx="33" cy="16" r="3" /><circle cx="28" cy="32" r="3" /><circle cx="12" cy="32" r="3" /><circle cx="7" cy="16" r="3" />
      </svg>
    )
  if (mode === 'pipe')
    return (
      <svg viewBox="0 0 40 40" style={s} fill="currentColor" aria-hidden>
        <circle cx="6" cy="20" r="3.5" /><circle cx="20" cy="11" r="3" /><circle cx="20" cy="20" r="3" /><circle cx="20" cy="29" r="3" /><circle cx="34" cy="20" r="3.5" />
        <path d="M9.5 20h7M9 18l8-6M9 22l8 6M23 11l8 7M23 20h7.5M23 29l8-7" {...line} />
      </svg>
    )
  if (mode === 'cross')
    return (
      <svg viewBox="0 0 40 40" style={s} fill="currentColor" aria-hidden>
        <circle cx="8" cy="9" r="3" /><circle cx="20" cy="9" r="3" /><circle cx="32" cy="9" r="3" />
        <path d="M8 13l12 13M20 13v13M32 13 20 26" {...line} />
        <rect x="15" y="27" width="10" height="8" rx="2.5" />
      </svg>
    )
  return (
    <svg viewBox="0 0 40 40" style={s} fill="currentColor" aria-hidden>
      <circle cx="8" cy="16" r="4" /><circle cx="32" cy="16" r="4" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M14 16h4M22 16h4" stroke="currentColor" strokeWidth="1.6" />
      <rect x="16" y="26" width="8" height="8" rx="2.5" />
    </svg>
  )
}

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg viewBox="0 0 28 28" width={size} height={size} aria-hidden>
      <circle cx="14" cy="14" r="6.5" fill="#1A1A1C" />
      <circle cx="14" cy="3.2" r="2.2" fill="#C9842F" /><circle cx="24.3" cy="10.7" r="2.2" fill="#14996F" />
      <circle cx="20.4" cy="22.8" r="2.2" fill="#3C78F0" /><circle cx="7.6" cy="22.8" r="2.2" fill="#8659E8" />
      <circle cx="3.7" cy="10.7" r="2.2" fill="none" stroke="#1A1A1C" strokeWidth="1.4" />
    </svg>
  )
}
