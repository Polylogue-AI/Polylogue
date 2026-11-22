import { useEffect, useRef, useState, type ClipboardEvent, type FormEvent, type KeyboardEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { api, USE_MOCK } from '../api'
import { BrandMark } from '../components/Icon'
import { RoundTable, type TableSeat } from '../components/RoundTable'
import { useSession } from '../state/session'

const DEMO: TableSeat[] = [
  { id: 'a', name: 'Claude', short: 'C', color: '#C9842F', kind: 'ai' },
  { id: 'b', name: '林', short: '林', color: '#FFD8A8', kind: 'human' },
  { id: 'c', name: 'GPT', short: 'G', color: '#14996F', kind: 'ai' },
  { id: 'd', name: '阿哲', short: '哲', color: '#CDE8FF', kind: 'human' },
  { id: 'e', name: 'Gemini', short: 'Ge', color: '#3C78F0', kind: 'ai' },
  { id: 'f', name: 'DeepSeek', short: 'D', color: '#36458F', kind: 'ai' },
  { id: 'g', name: '小雨', short: '雨', color: '#D9F2DF', kind: 'human' },
  { id: 'h', name: 'Qwen', short: 'Q', color: '#8659E8', kind: 'ai' },
]

export function LoginPage() {
  const { user, setUser } = useSession()
  const nav = useNavigate()
  const [code, setCode] = useState<string[]>(Array(6).fill(''))
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(0)
  const boxes = useRef<(HTMLInputElement | null)[]>([])

  useEffect(() => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setTick((x) => x + 1), 1800)
    return () => clearInterval(t)
  }, [])

  if (user) return <Navigate to="/rooms" replace />

  const setAt = (i: number, v: string) => {
    const ch = v.replace(/[^0-9a-z]/gi, '').slice(-1).toUpperCase()
    setCode((c) => c.map((x, j) => (j === i ? ch : x)))
    if (ch && i < 5) boxes.current[i + 1]?.focus()
  }
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !code[i] && i > 0) boxes.current[i - 1]?.focus()
  }
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const t = e.clipboardData.getData('text').replace(/[^0-9a-z]/gi, '').toUpperCase().slice(0, 6)
    if (!t) return
    e.preventDefault()
    setCode(Array.from({ length: 6 }, (_, i) => t[i] ?? ''))
    boxes.current[Math.min(t.length, 5)]?.focus()
  }

  async function submit(e: FormEvent) {
    e.preventDefault()
    const c = code.join('')
    if (c.length !== 6) return setError('邀请码是 6 位')
    if (!name.trim()) return setError('写一个你在桌上的名字')
    setBusy(true)
    setError('')
    try {
      setUser(await api.login(c, name.trim()))
      nav('/rooms')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const active = DEMO[tick % DEMO.length]
  return (
    <section className="login">
      <div className="login-art" aria-hidden>
        <RoundTable seats={DEMO} active={active.id} w={400} h={400} r={150} t={86}
          center={<><text x={200} y={196} textAnchor="middle" fontSize={15} fontWeight={600} fill="#1A1A1C">{active.name}</text><text x={200} y={216} textAnchor="middle" fontSize={12} fill="#8E8E95">正在发言</text></>} />
        <p className="caption">每个座位上是一位成员：你的朋友，或是一个配置好角色的模型。轮到谁发言，谁的座位会亮起。</p>
      </div>
      <form className="login-form" onSubmit={submit}>
        <BrandMark size={44} />
        <div>
          <h1>Roundtable</h1>
          <p className="lede" style={{ marginTop: 12 }}>让几个模型和你的朋友坐在同一张桌子旁，一起把事情想清楚。</p>
        </div>
        <div className="field">
          <label htmlFor="c0">邀请码</label>
          <div className="code-boxes">
            {code.map((v, i) => (
              <input key={i} id={`c${i}`} ref={(el) => { boxes.current[i] = el }} value={v} maxLength={2} inputMode="text" autoComplete="off"
                aria-label={`邀请码第 ${i + 1} 位`} onChange={(e) => setAt(i, e.target.value)} onKeyDown={(e) => onKey(i, e)} onPaste={onPaste} />
            ))}
          </div>
        </div>
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="nick">你在桌上的名字</label>
          <input className="input" id="nick" value={name} onChange={(e) => setName(e.target.value)} autoComplete="nickname" placeholder="例如：林" />
        </div>
        <div className="login-error" role="alert">{error}</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-ink btn-lg" type="submit" disabled={busy}>{busy ? '进入中…' : '进入'}</button>
          <span className="hint">{USE_MOCK ? '模拟模式：任意 6 位邀请码都能进入，名字填"林"即为管理员。' : '邀请码由管理员生成，6 位，大小写不敏感。'}</span>
        </div>
      </form>
    </section>
  )
}
