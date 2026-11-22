import Markdown from 'react-markdown'
import type { Message, Seat } from '../api'
import { yuan } from '../labels'
import { useSession } from '../state/session'
import { Avatar } from './Avatar'

/** 把人类消息里的 @名字 高亮。内容按纯文本处理，不解析 HTML */
export function HumanText({ text, seats }: { text: string; seats: Seat[] }) {
  const names = seats.map((s) => s.name).sort((a, b) => b.length - a.length)
  if (!names.length) return <span className="human-text">{text}</span>
  const esc = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`(@(?:${esc.join('|')}))`, 'g')
  return (
    <span className="human-text">
      {text.split(re).map((part, i) => (i % 2 === 1 ? <span key={i} className="at">{part}</span> : part))}
    </span>
  )
}

export function MarkdownText({ text }: { text: string }) {
  return <div className="md"><Markdown>{text}</Markdown></div>
}

interface Props {
  m: Pick<Message, 'author_id' | 'kind' | 'content' | 'cost_cny' | 'interrupted' | 'streaming' | 'reply_to'> & { id?: string }
  seats: Seat[]
  replyName?: string | null
  pending?: boolean
}

export function MessageItem({ m, seats, replyName, pending }: Props) {
  const { who } = useSession()
  if (m.kind === 'system') return <div className="sys-line">{m.content}</div>
  const seat = seats.find((s) => s.id === m.author_id)
  const p = seat ?? who(m.author_id)
  if (!p) return null
  const isAi = p.kind === 'ai'
  const role = seat?.role ?? (isAi ? (p as { role?: string }).role : undefined)
  return (
    <div className={`msg ${p.kind} ${m.kind === 'steer' ? 'steer' : ''} ${pending ? 'pending' : ''}`} style={{ ['--seat' as string]: p.color }}>
      <Avatar name={p.name} short={p.short} color={p.color} kind={p.kind} />
      <div className="body">
        <div className="who">
          <b>{p.name}</b>
          <span className="role">{m.kind === 'steer' ? '方向指示' : isAi ? role : pending ? '发送中…' : ''}</span>
          {m.cost_cny != null && !m.streaming && <span className="cost num" title="预估费用">{m.cost_cny === 0 ? '免费' : yuan(m.cost_cny, 3)}</span>}
        </div>
        {replyName && <div className="reply-to">回复 {replyName}</div>}
        <div className="text">
          {isAi ? <MarkdownText text={m.content} /> : <HumanText text={m.content} seats={seats} />}
          {m.streaming && <span className="caret" />}
        </div>
        {m.interrupted && <div className="interrupted">（被打断）</div>}
      </div>
    </div>
  )
}
