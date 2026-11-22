import { useEffect, useState } from 'react'
import { api, type Usage, type UsageRange } from '../api'
import { Avatar } from '../components/Avatar'
import { Icon, ModeGlyph } from '../components/Icon'
import { yuan } from '../labels'
import { useSession } from '../state/session'

function Ring({ ratio, color, label }: { ratio: number; color: string; label: string }) {
  const C = 2 * Math.PI * 31
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" aria-hidden>
      <circle cx="38" cy="38" r="31" fill="none" stroke="#ECECF0" strokeWidth="8" />
      <circle cx="38" cy="38" r="31" fill="none" stroke={color} strokeWidth="8" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(1, ratio))} transform="rotate(-90 38 38)" />
      <text x="38" y="43" textAnchor="middle" fontSize="15" fontWeight="700" fill="#1A1A1C">{label}</text>
    </svg>
  )
}

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`)

export function UsagePage() {
  const { who, members } = useSession()
  const [range, setRange] = useState<UsageRange>('month')
  const [u, setU] = useState<Usage | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => { setErr(null); api.usage(range).then(setU).catch((e) => setErr(e.message)) }, [range])

  const memberIds = u ? [...new Set(u.by_day.flatMap((d) => Object.keys(d.by_member)))] : []
  const maxDay = u ? Math.max(0.01, ...u.by_day.map((d) => Object.values(d.by_member).reduce((a, b) => a + b, 0))) : 1
  const colorOf = (id: string) => who(id)?.color ?? members.find((m) => m.id === id)?.color ?? '#999'
  const ratio = u?.team_budget_cny ? u.total_cny / u.team_budget_cny : 0
  const tokens = u ? u.tokens_in + u.tokens_out : 0

  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <div><h1>用量与费用</h1><p>大家共用同一组 API Key，费用记在房间创建人名下。金额按 LiteLLM 价格表估算。</p></div>
          <div className="seg" role="group" aria-label="时间范围">
            {(['week', 'month', 'all'] as UsageRange[]).map((r) => (
              <button key={r} aria-pressed={range === r} onClick={() => setRange(r)}>{{ week: '本周', month: '本月', all: '全部' }[r]}</button>
            ))}
          </div>
        </div>
        {err && <p className="error-text">{err}</p>}
        {!u ? <div className="center-fill">加载中…</div> : (
          <>
            <div className="stat-row">
              <div className="stat-main">
                <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>合计（预估）</div>
                <div className="big num">{yuan(u.total_cny)}{u.team_budget_cny != null && <small>/ {yuan(u.team_budget_cny, 0)}</small>}</div>
              </div>
              <div className="ring-card">
                <Ring ratio={ratio} color={ratio > 0.85 ? 'var(--warn)' : 'var(--ink)'} label={u.team_budget_cny ? `${Math.round(ratio * 100)}%` : '—'} />
                <div><b>团队预算</b><span>{u.team_budget_cny ? `还剩 ${yuan(Math.max(0, u.team_budget_cny - u.total_cny))}` : '这个时间范围没有预算'}</span></div>
              </div>
              <div className="ring-card">
                <Ring ratio={tokens ? u.tokens_in / tokens : 0} color="var(--c-gpt)" label={fmtTokens(tokens)} />
                <div><b>tokens</b><span>其中 {tokens ? Math.round((u.tokens_in / tokens) * 100) : 0}% 是输入</span></div>
              </div>
            </div>

            <div className="panel" style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <b style={{ fontSize: 15 }}>每日费用，按模型</b><span className="faint" style={{ fontSize: 12.5 }}>单位：元</span>
              </div>
              <div className="chart">
                {u.by_day.map((d, i) => {
                  const tot = Object.values(d.by_member).reduce((a, b) => a + b, 0)
                  const last = i === u.by_day.length - 1
                  const every = Math.ceil(u.by_day.length / 8)
                  return (
                    <div key={d.date} className={`col ${last ? 'today' : ''}`} style={{ height: `${(tot / maxDay) * 100}%` }} title={`${d.date}：${yuan(tot)}`}>
                      {memberIds.map((id) => d.by_member[id] ? <span key={id} style={{ height: `${(d.by_member[id] / (tot || 1)) * 100}%`, background: colorOf(id) }} /> : null)}
                      {(i % every === 0 || last) && <em>{last ? '今天' : `${Number(d.date.slice(8))} 日`}</em>}
                    </div>
                  )
                })}
              </div>
              <div className="legend">
                {memberIds.map((id) => <span key={id}><i style={{ background: colorOf(id) }} />{who(id)?.name ?? id}</span>)}
              </div>
            </div>

            <div className="usage-cols">
              <div className="panel">
                <b style={{ fontSize: 15 }}>按人</b>
                <div style={{ marginTop: 10 }}>
                  {u.by_user.map((p) => {
                    const w = who(p.user_id)
                    const r = p.limit_cny ? p.cost_cny / p.limit_cny : 0
                    return (
                      <div className="person-row" key={p.user_id}>
                        {w ? <Avatar {...w} /> : <span />}
                        <div><b>{w?.name ?? p.user_id}</b><div className="meter"><i style={{ width: `${Math.min(100, r * 100)}%`, background: r > 0.85 ? 'var(--warn)' : undefined }} /></div></div>
                        <div className="amt num">{yuan(p.cost_cny)}<small>{p.limit_cny ? `上限 ${yuan(p.limit_cny, 0)}` : '不限'}</small></div>
                      </div>
                    )
                  })}
                </div>
              </div>
              <div className="panel">
                <b style={{ fontSize: 15 }}>花费最多的房间</b>
                <div style={{ marginTop: 10 }}>
                  {u.by_room.map((r) => {
                    const ratio = r.budget_cny ? r.cost_cny / r.budget_cny : 0
                    return (
                      <div className="person-row" key={r.room_id}>
                        <span style={{ width: 30, height: 30, display: 'grid', placeItems: 'center', background: 'var(--paper)', borderRadius: 9 }}><ModeGlyph mode={r.mode} size={20} /></span>
                        <div><b>{r.title}</b><div className="meter"><i style={{ width: `${Math.min(100, ratio * 100)}%`, background: ratio > 0.85 ? 'var(--warn)' : undefined }} /></div></div>
                        <div className="amt num">{yuan(r.cost_cny)}<small>上限 {yuan(r.budget_cny, 0)}</small></div>
                      </div>
                    )
                  })}
                </div>
                {u.by_room.filter((r) => r.budget_cny && r.cost_cny / r.budget_cny > 0.85).map((r) => (
                  <div className="alert-line" key={r.room_id}>
                    <Icon name="warn" style={{ flex: 'none', color: 'var(--warn)' }} />
                    <div>「{r.title}」已用掉预算的 {Math.round((r.cost_cny / r.budget_cny) * 100)}%，到上限时会自动停止。</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
