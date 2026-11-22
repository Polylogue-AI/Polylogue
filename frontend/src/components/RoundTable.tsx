import type { ReactNode } from 'react'

export interface TableSeat { id: string; name: string; short: string; color: string; kind: 'human' | 'ai' }

interface Props {
  seats: TableSeat[]
  active: string | null
  w?: number
  h?: number
  r?: number
  t?: number
  center?: ReactNode
  labels?: boolean
}

/** 圆桌座位图：发言者的座位放大并有呼吸光圈。AI 用圆角方块，人用圆形 */
export function RoundTable({ seats, active, w = 280, h = 250, r = 88, t = 48, center, labels = true }: Props) {
  const cx = w / 2
  const cy = h / 2
  const activeName = seats.find((s) => s.id === active)?.name
  return (
    <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={activeName ? `${activeName} 正在发言` : '圆桌座位图'}>
      <circle cx={cx} cy={cy} r={t} fill="#F4F4F6" stroke="rgba(0,0,0,.06)" />
      {center}
      {seats.map((s, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / seats.length
        const x = cx + r * Math.cos(a)
        const y = cy + r * Math.sin(a)
        const on = s.id === active
        const sz = on ? 17 : 14
        const dim = !!active && !on
        const ly = y + (Math.sin(a) > 0.2 ? 32 : Math.sin(a) < -0.2 ? -24 : 30)
        return (
          <g key={s.id}>
            {on && (
              <>
                <line x1={cx + (t + 4) * Math.cos(a)} y1={cy + (t + 4) * Math.sin(a)} x2={x - 18 * Math.cos(a)} y2={y - 18 * Math.sin(a)}
                  stroke={s.color} strokeWidth={2} strokeLinecap="round" strokeDasharray="2 4" className="seat-beam" />
                <circle cx={x} cy={y} r={22} fill="none" stroke={s.color} strokeWidth={2} className="seat-pulse" />
              </>
            )}
            {s.kind === 'ai'
              ? <rect x={x - sz} y={y - sz} width={sz * 2} height={sz * 2} rx={sz * 0.6} fill={s.color} opacity={dim ? 0.55 : 1} />
              : <circle cx={x} cy={y} r={sz} fill={s.color} opacity={dim ? 0.7 : 1} />}
            <text x={x} y={y + 4.5} textAnchor="middle" fontSize={on ? 13 : 11.5} fontWeight={600} fill={s.kind === 'ai' ? '#fff' : '#1A1A1C'}>{s.short}</text>
            {labels && <text x={x} y={ly} textAnchor="middle" fontSize={10.5} fill={on ? '#1A1A1C' : '#8E8E95'} fontWeight={on ? 600 : 400}>{s.name}</text>}
          </g>
        )
      })}
    </svg>
  )
}
