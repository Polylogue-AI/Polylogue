import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type Duty, type Mode } from '../api'
import { DUTY_NAME, MODE_DUTIES, MODE_FIT, MODE_NAME, defaultDuties } from '../labels'
import { useSession } from '../state/session'
import { useToast } from '../state/toast'
import { Avatar } from './Avatar'
import { Icon, ModeGlyph } from './Icon'

const MODES: Mode[] = ['round', 'pipe', 'cross', 'debate']

export function NewRoomSheet({ initialMode, onClose }: { initialMode: Mode; onClose(): void }) {
  const { members, users, user, refreshRooms } = useSession()
  const toast = useToast()
  const nav = useNavigate()
  const [topic, setTopic] = useState('')
  const [mode, setMode] = useState<Mode>(initialMode)
  const [ais, setAis] = useState<string[]>(() => members.slice(0, 3).map((m) => m.id))
  const [humans, setHumans] = useState<string[]>([])
  const [override, setOverride] = useState<Record<string, Duty>>({})
  const [rounds, setRounds] = useState(3)
  const [budget, setBudget] = useState('10')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  // 成员列表可能在弹窗打开后才加载完，这时补上默认入座的模型
  const touched = useRef(false)
  useEffect(() => {
    if (!touched.current && ais.length === 0 && members.length) setAis(members.slice(0, 3).map((m) => m.id))
  }, [members, ais.length])

  // 换模式时清空手动指定的职责
  useEffect(() => setOverride({}), [mode])

  const duties = useMemo(() => ({ ...defaultDuties(mode, ais), ...override }), [mode, ais, override])
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const problem = (() => {
    if (!topic.trim()) return '先写下要讨论的事情'
    if (ais.length < 2) return '至少选择 2 个模型'
    const vals = Object.values(duties)
    if (mode === 'debate' && !(['pro', 'con', 'judge'] as Duty[]).every((d) => vals.includes(d))) return '辩论需要正方、反方和裁判至少各一位'
    if (mode === 'cross' && !vals.includes('judge')) return '交叉验证需要一位裁判'
    if (mode === 'cross' && vals.filter((d) => d === 'answerer').length < 2) return '交叉验证至少需要 2 位回答者'
    if (mode === 'pipe' && !vals.includes('planner')) return '流水线需要一位规划者'
    if (mode === 'pipe' && !vals.includes('executor')) return '流水线需要至少一位执行者'
    if (!(Number(budget) > 0)) return '预算要大于 0'
    return null
  })()

  const est = useMemo(() => {
    const per = ais.reduce((a, id) => a + (members.find((m) => m.id === id)?.model.startsWith('ollama/') ? 0 : 0.2), 0)
    const factor = mode === 'round' || mode === 'debate' ? rounds : mode === 'pipe' ? 2.5 : 2
    return per * factor
  }, [ais, members, mode, rounds])

  async function submit() {
    if (problem) return setError(problem)
    setBusy(true)
    setError(null)
    try {
      const room = await api.createRoom({
        topic: topic.trim(), mode, ai_member_ids: ais, human_user_ids: humans,
        duties: Object.keys(override).length ? duties : undefined,
        rounds, budget_cny: Number(budget), auto_start: true,
      })
      await refreshRooms()
      onClose()
      nav(`/rooms/${room.id}`)
      toast('房间已创建，讨论马上开始')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheetTitle">
        <div className="sheet-head">
          <h2 id="sheetTitle">新建房间</h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          <div className="field" style={{ marginBottom: 20 }}>
            <label htmlFor="topic">要讨论的事情</label>
            <textarea className="textarea" id="topic" autoFocus style={{ minHeight: 72 }} value={topic} onChange={(e) => setTopic(e.target.value)}
              placeholder="例如：我们的后端用 FastAPI 还是 Node？请从开发速度、AI 生态、部署成本三方面比较。" />
          </div>

          <div className="field" style={{ marginBottom: 20 }}>
            <label id="modeLabel">协作方式</label>
            <div className="mode-pick" role="radiogroup" aria-labelledby="modeLabel">
              {MODES.map((m) => (
                <button key={m} className="mode-opt" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                  <ModeGlyph mode={m} size={34} />
                  <div><b>{MODE_NAME[m]}</b><span>{MODE_FIT[m]}</span></div>
                </button>
              ))}
            </div>
          </div>

          <div className="field" style={{ marginBottom: 20 }}>
            <label>请哪些模型入座（按发言顺序）</label>
            <div className="pick-members">
              {members.map((m) => (
                <button key={m.id} className="pm" role="checkbox" aria-checked={ais.includes(m.id)} onClick={() => { touched.current = true; toggle(ais, setAis, m.id) }}>
                  <Avatar {...m} kind="ai" size="sm" />
                  <div>{m.name}<small>{m.role}</small></div>
                </button>
              ))}
            </div>
          </div>

          {ais.length > 0 && (
            <div className="field" style={{ marginBottom: 20 }}>
              <label>各自的职责（已按规则自动分配，可以修改）</label>
              <div className="duty-list">
                {ais.map((id, i) => {
                  const m = members.find((x) => x.id === id)!
                  return (
                    <div className="duty-row" key={id}>
                      <span className="faint num" style={{ width: 16 }}>{i + 1}</span>
                      <Avatar {...m} kind="ai" size="sm" />{m.name}
                      <select className="select" aria-label={`${m.name} 的职责`} value={duties[id]}
                        onChange={(e) => setOverride({ ...duties, [id]: e.target.value as Duty })}>
                        {MODE_DUTIES[mode].map((d) => <option key={d} value={d}>{DUTY_NAME[d]}</option>)}
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="field" style={{ marginBottom: 20 }}>
            <label>邀请朋友（你自己会自动加入）</label>
            <div className="pick-members">
              {users.filter((u) => u.id !== user?.id).map((u) => (
                <button key={u.id} className="pm" role="checkbox" aria-checked={humans.includes(u.id)} onClick={() => toggle(humans, setHumans, u.id)}>
                  <Avatar {...u} kind="human" size="sm" />
                  <div>{u.name}<small>{u.is_admin ? '管理员' : '朋友'}</small></div>
                </button>
              ))}
            </div>
          </div>

          <div className="form-grid">
            {mode !== 'cross' && (
              <div className="field">
                <label htmlFor="rounds">{mode === 'pipe' ? '最多返工次数' : mode === 'debate' ? '辩论回合数' : '讨论轮数'}</label>
                <div className="range-row">
                  <input type="range" id="rounds" min={1} max={6} value={rounds} style={{ ['--p' as string]: `${((rounds - 1) / 5) * 100}%` }}
                    onChange={(e) => setRounds(Number(e.target.value))} />
                  <span className="range-val num">{rounds} {mode === 'pipe' ? '次' : mode === 'debate' ? '回合' : '轮'}</span>
                </div>
              </div>
            )}
            <div className="field">
              <label htmlFor="budget">本房间预算上限（元）</label>
              <input className="input num" id="budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^\d.]/g, ''))} />
            </div>
          </div>
        </div>
        <div className="sheet-foot">
          <span className={error ? 'error-text' : 'faint'} style={{ fontSize: 12.5 }}>
            {error ?? `${ais.length} 个模型，预计花费约 ¥${est.toFixed(2)}（粗略估计）`}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-quiet" onClick={onClose}>取消</button>
            <button className="btn btn-ink" onClick={submit} disabled={busy}>{busy ? '创建中…' : '开始讨论'}</button>
          </div>
        </div>
      </div>
    </div>
  )
}
