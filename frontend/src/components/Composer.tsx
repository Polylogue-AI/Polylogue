import { useRef, useState, type KeyboardEvent } from 'react'
import type { Seat } from '../api'
import { Avatar } from './Avatar'
import { Icon } from './Icon'

/**
 * 按 @ 在文字里出现的先后排序，后端按这个顺序安排发言（契约 3.4）。
 * 名字长的先匹配，避免"Claude"把"Claude Opus"的位置占掉；同一个人只算第一次。
 */
export function mentionsInOrder(text: string, ais: Seat[]): string[] {
  const hits: { id: string; at: number }[] = []
  const taken: [number, number][] = []
  for (const s of [...ais].sort((a, b) => b.name.length - a.name.length)) {
    const token = `@${s.name}`
    let from = 0
    let at = -1
    while ((at = text.indexOf(token, from)) >= 0) {
      const end = at + token.length
      if (!taken.some(([a, b]) => at < b && end > a)) break
      from = at + 1
    }
    if (at >= 0) {
      taken.push([at, at + token.length])
      hits.push({ id: s.id, at })
    }
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id)
}

interface Props {
  seats: Seat[]
  disabled?: boolean
  onSay(content: string, mentions: string[]): void
  onSteer(content: string): void
}

/**
 * 输入框：@ 点名、方向指示。
 * 名字可以带空格（如"Llama 本地"），点名结果按选中的成员 ID 记录，而不是靠正则猜（评估 B2）。
 */
export function Composer({ seats, disabled, onSay, onSteer }: Props) {
  const [text, setText] = useState('')
  const [steer, setSteer] = useState(false)
  const [query, setQuery] = useState<string | null>(null)
  const [idx, setIdx] = useState(0)
  const ref = useRef<HTMLTextAreaElement>(null)
  const ais = seats.filter((s) => s.kind === 'ai')
  const list = query == null ? [] : ais.filter((s) => s.name.toLowerCase().includes(query.toLowerCase()))

  function onChange(v: string) {
    setText(v)
    const el = ref.current
    if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` }
    const m = v.match(/@([^@\n]{0,12})$/)
    setQuery(m && !steer ? m[1] : null)
    setIdx(0)
  }

  function pick(s: Seat) {
    setText((t) => t.replace(/@([^@\n]{0,12})$/, `@${s.name} `))
    setQuery(null)
    ref.current?.focus()
  }

  function send() {
    const v = text.trim()
    if (!v || disabled) return
    if (steer) onSteer(v)
    else onSay(v, mentionsInOrder(v, ais))
    setText('')
    setQuery(null)
    if (ref.current) ref.current.style.height = 'auto'
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (list.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(list[idx]); return }
      if (e.key === 'Escape') { setQuery(null); return }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send() }
  }

  return (
    <div className="composer">
      {list.length > 0 && (
        <div className="mention-pop" role="listbox" aria-label="点名">
          {list.map((s, i) => (
            <button key={s.id} role="option" aria-selected={i === idx} className={i === idx ? 'on' : ''} onMouseDown={(e) => { e.preventDefault(); pick(s) }}>
              <Avatar {...s} size="sm" />{s.name}<span className="faint">{s.role}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-box" style={steer ? { background: 'var(--signal-soft)' } : undefined}>
        <div className="tools">
          <button className="icon-btn" aria-pressed={steer} aria-label="切换为方向指示" title="方向指示：之后每个模型都会遵循这条要求"
            onClick={() => { setSteer((s) => !s); setQuery(null) }} style={steer ? { color: 'var(--signal)' } : undefined}>
            <Icon name="steer" />
          </button>
        </div>
        <textarea ref={ref} rows={1} value={text} disabled={disabled} aria-label="消息"
          placeholder={steer ? '方向指示，例如：接下来只讨论成本，别再谈技术选型' : '插话、提问，或输入 @ 点名某个模型'}
          onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} />
        <button className="send" aria-label="发送" onClick={send} disabled={disabled}><Icon name="send" style={{ stroke: '#fff' }} /></button>
      </div>
      <div className="composer-hint">
        {steer
          ? '方向指示会加入之后每个模型的设定里，直到讨论结束。'
          : '发送后不会打断正在说话的模型，下一位会先回应你。被 @ 的模型排到下一位。'}
      </div>
    </div>
  )
}
