import { Fragment } from 'react'
import type { Message, Room, RoomState, Seat } from '../api'
import type { Pending } from '../state/roomReducer'
import { Avatar } from './Avatar'
import { Icon } from './Icon'
import { MarkdownText, MessageItem } from './MessageItem'
import { RunCard } from './RunCard'

interface ViewProps {
  room: Room
  messages: Message[]
  state: RoomState | null
  pending: Pending[]
}

const seatName = (seats: Seat[], id: string | null) => seats.find((s) => s.id === id)?.name ?? null

function PendingList({ pending, seats }: { pending: Pending[]; seats: Seat[] }) {
  return (
    <>
      {pending.map((p) => (
        <MessageItem key={p.client_id} pending seats={seats}
          m={{ author_id: p.author_id, kind: 'chat', content: p.content, cost_cny: null, interrupted: false, streaming: false, reply_to: null }} />
      ))}
    </>
  )
}

function Chat({ m, room, all }: { m: Message; room: Room; all: Message[] }) {
  const reply = m.reply_to ? all.find((x) => x.id === m.reply_to) : null
  return <MessageItem m={m} seats={room.seats} replyName={reply ? seatName(room.seats, reply.author_id) : null} />
}

/* ---------------- 圆桌 ---------------- */
export function RoundView({ room, messages, pending }: ViewProps) {
  let lastRound = 0
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>讨论的问题</p>
      <div className="cv-q">{room.topic}</div>
      {messages.map((m) => {
        const mark = m.round > lastRound && m.kind !== 'summary' ? m.round : null
        if (mark) lastRound = m.round
        return (
          <Fragment key={m.id}>
            {mark && <div className="round-mark">第 {mark} 轮</div>}
            {m.kind === 'summary' ? (
              <div className="summary-card">
                <h4><Icon name="spark" size={16} style={{ color: 'var(--signal)' }} />{seatName(room.seats, m.author_id)} 的阶段结论</h4>
                <MarkdownText text={m.content} />
                {m.streaming && <span className="caret" />}
              </div>
            ) : <Chat m={m} room={room} all={messages} />}
          </Fragment>
        )
      })}
      <PendingList pending={pending} seats={room.seats} />
    </>
  )
}

/* ---------------- 流水线 ---------------- */
const TASK_ST = { queued: ['排队中', 'wait'], running: ['进行中', 'run'], done: ['已完成', 'done'], needs_fix: ['需修改', 'flag'] } as const

export function PipeView({ room, messages, state, pending }: ViewProps) {
  const tasks = state?.mode_state.tasks ?? []
  const col = (n: number, title: string, sub: string, stage: string) => {
    const list = tasks.filter((t) => t.stage === stage)
    const hasAny = list.length > 0
    return (
      <div className="pipe-col">
        <div className="pipe-head"><span className={`n ${hasAny ? '' : 'wait'}`}>{n}</span><div>{title}<small>{sub}</small></div></div>
        {list.map((t) => {
          const s = room.seats.find((x) => x.id === t.assignee_id)
          const [label, cls] = TASK_ST[t.status]
          return (
            <div className="task" key={t.id} style={{ ['--seat' as string]: s?.color }}>
              <div className="t-top">{s && <Avatar {...s} size="sm" />}{s?.name}<span className={`st ${cls}`}>{label}</span></div>
              {t.title}{t.rework_count > 0 && <span className="rework">返工 {t.rework_count} 次</span>}
              {t.status === 'running' && <div className="bar"><i /></div>}
            </div>
          )
        })}
        {!hasAny && <div className="task empty">暂无</div>}
      </div>
    )
  }
  const taskTitle = (id?: string) => tasks.find((t) => t.id === id)?.title
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>任务</p>
      <div className="cv-q">{room.topic}</div>
      <div className="pipe">
        {col(1, '规划', '拆分任务', 'plan')}
        {col(2, '执行', '执行者分头完成', 'exec')}
        {col(3, '审查', '逐个核对', 'review')}
        {col(4, '汇总', '审查通过的任务', 'merge')}
      </div>
      {messages.map((m) => (
        <Fragment key={m.id}>
          {m.meta.task_id && <div className="reply-to" style={{ marginLeft: 42, marginBottom: -6 }}>
            任务：{taskTitle(m.meta.task_id) ?? m.meta.task_id}
            {m.meta.verdict && <span className={`st ${m.meta.verdict === 'approved' ? 'done' : 'flag'}`} style={{ marginLeft: 8 }}>{m.meta.verdict === 'approved' ? '审查通过' : '退回修改'}</span>}
          </div>}
          {m.kind === 'summary'
            ? <div className="summary-card"><h4><Icon name="spark" size={16} style={{ color: 'var(--signal)' }} />汇总</h4><MarkdownText text={m.content} />{m.streaming && <span className="caret" />}</div>
            : <Chat m={m} room={room} all={messages} />}
        </Fragment>
      ))}
      <PendingList pending={pending} seats={room.seats} />
    </>
  )
}

/* ---------------- 交叉验证 ---------------- */
export function CrossView({ room, messages, state, pending }: ViewProps) {
  const allAnswers = messages.filter((m) => m.meta.phase === 'answer')
  // 一次回答可能由几段组成：文字 → 运行代码 → 文字（契约 4.4）。
  // 并发阶段被打断的回答会重新生成（契约 3.4），每位回答者只显示最近一次尝试的所有片段。
  const byAuthor = new Map<string, Message[]>()
  for (const m of allAnswers) {
    const key = m.author_id ?? m.id
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), m])
  }
  const fallback = (i: number) => `回答 ${String.fromCharCode(65 + i)}`
  const answers = [...byAuthor.entries()].map(([key, list], i) => {
    const cuts = list.map((m, j) => (m.interrupted && !m.streaming ? j : -1)).filter((j) => j >= 0)
    const lastCut = cuts[cuts.length - 1] ?? -1
    // 最后一段就是被打断的：这次尝试还没重做，显示它；否则显示最后一次打断之后的重做结果
    const from = lastCut === list.length - 1 ? (cuts[cuts.length - 2] ?? -1) + 1 : lastCut + 1
    const parts = list.slice(from)
    const m = parts[parts.length - 1]
    const redone = from > 0
    return { key, parts, m, redone, label: list.find((x) => x.meta.anon_label)?.meta.anon_label ?? fallback(i) }
  }).sort((a, b) => a.label.localeCompare(b.label, 'zh-CN', { numeric: true }))
  const reviews = messages.filter((m) => m.meta.phase === 'review')
  const verdict = messages.find((m) => m.kind === 'verdict')
  const others = messages.filter((m) => !m.meta.phase && m.kind !== 'verdict')
  const phase = state?.mode_state.phase
  return (
    <>
      <p className="muted" style={{ fontSize: 13 }}>同一个问题，同时发给 {answers.length || room.seats.filter((x) => x.duty === 'answerer').length} 个模型</p>
      <div className="cv-q">{room.topic}</div>
      {answers.length > 0 && (
        <div className="cv-grid">
          {answers.map(({ key, parts, m, redone, label }) => {
            const s = room.seats.find((x) => x.id === m.author_id)
            return (
              <div className="cv-card" key={key}>
                <div className="h">{s && <Avatar {...s} size="sm" />}<b>{s?.name}</b><span className="faint" style={{ marginLeft: 'auto', fontSize: 12 }}>{label}</span></div>
                {parts.map((x) => x.kind === 'run' && x.meta.run
                  ? <RunCard key={x.id} bare run={x.meta.run} authorId={x.author_id} seats={room.seats} interrupted={false} streaming={x.streaming} cost={x.cost_cny} />
                  : <div key={x.id}><MarkdownText text={x.content} source={x.streaming ? undefined : { authorId: x.author_id, authorName: s?.name ?? '', messageId: x.id }} />{x.streaming && <span className="caret" />}</div>)}
                {m.interrupted && !m.streaming && <div className="interrupted" style={{ fontSize: 12, color: 'var(--warn)' }}>（被打断，继续后会重新生成）</div>}
                {redone && !m.interrupted && <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>被打断后重新生成</div>}
              </div>
            )
          })}
        </div>
      )}
      {reviews.length > 0 && (
        <details className="reviews" open={phase === 'review'}>
          <summary>匿名互评（{reviews.length} 份）：每位回答者在不知道作者的情况下点评其他回答</summary>
          {reviews.map((m) => {
            const s = room.seats.find((x) => x.id === m.author_id)
            return (
              <div className="rv" key={m.id}>
                {s && <Avatar {...s} size="sm" />}
                <div style={{ flex: 1 }}><b style={{ fontSize: 12.5 }}>{s?.name} 的点评</b><MarkdownText text={m.content} />{m.streaming && <span className="caret" />}</div>
              </div>
            )
          })}
        </details>
      )}
      {verdict && (() => {
        const s = room.seats.find((x) => x.id === verdict.author_id)
        return (
          <div className="verdict">
            <h4>{s && <Avatar {...s} size="sm" />}裁判 {s?.name} 的结论</h4>
            <MarkdownText text={verdict.content} />{verdict.streaming && <span className="caret" style={{ background: '#fff' }} />}
            {(verdict.meta.agreements?.length || verdict.meta.disagreements?.length) ? (
              <div className="verdict-lists">
                <div><h6>共识</h6><ul>{verdict.meta.agreements?.map((x) => <li key={x}>{x}</li>)}</ul></div>
                <div><h6>分歧</h6><ul>{verdict.meta.disagreements?.map((x) => <li key={x}>{x}</li>)}</ul></div>
              </div>
            ) : null}
          </div>
        )
      })()}
      {others.map((m) => <Chat key={m.id} m={m} room={room} all={messages} />)}
      <PendingList pending={pending} seats={room.seats} />
    </>
  )
}

/* ---------------- 辩论 ---------------- */
export function DebateView({ room, messages, state, pending }: ViewProps) {
  const score = state?.mode_state.score_pro ?? null
  const proSeat = room.seats.find((s) => s.duty === 'pro')
  const conSeat = room.seats.find((s) => s.duty === 'con')
  return (
    <>
      <div className="debate-motion">
        <p className="muted" style={{ fontSize: 13 }}>辩题{state && state.round > 0 ? `，第 ${state.round} / ${state.total_rounds} 回合` : ''}</p>
        <h3>{room.topic}</h3>
        <p className="faint" style={{ fontSize: 12.5, marginTop: 6 }}>正方 {proSeat?.name ?? '—'}　·　反方 {conSeat?.name ?? '—'}</p>
      </div>
      <div className="scale" aria-label={score == null ? '裁判还没有评分' : `裁判当前倾向：正方 ${score}`}>
        <span className="side">正方 {score ?? '—'}</span>
        <div className="beam"><i style={{ width: `${score ?? 50}%`, opacity: score == null ? 0.25 : 1 }} /></div>
        <span className="side faint">{score == null ? '—' : 100 - score} 反方</span>
      </div>
      <div className="debate">
        {messages.map((m) => {
          const s = room.seats.find((x) => x.id === m.author_id)
          const side = m.meta.side
          if (m.kind === 'verdict') {
            return (
              <div key={m.id} className="verdict" style={{ gridColumn: '1 / -1', position: 'relative', zIndex: 1 }}>
                <h4>{s && <Avatar {...s} size="sm" />}裁判 {s?.name} 的最终判断</h4>
                <MarkdownText text={m.content} />{m.streaming && <span className="caret" style={{ background: '#fff' }} />}
              </div>
            )
          }
          if ((side === 'pro' || side === 'con') && s) {
            return (
              <div key={m.id} className={`arg ${side}`} style={{ gridColumn: side === 'pro' ? 1 : 2, marginTop: side === 'con' ? 0 : undefined }}>
                <div className="h"><Avatar {...s} size="sm" />{side === 'pro' ? '正方' : '反方'} {s.name}</div>
                <div className="bubble"><MarkdownText text={m.content || '……'} />{m.streaming && <span className="caret" />}</div>
                {m.interrupted && <div className="rebut">（被打断）</div>}
              </div>
            )
          }
          if (side === 'judge' && s) {
            return (
              <div key={m.id} className="judge-note">
                <Avatar {...s} size="sm" />
                <div><b style={{ color: 'var(--ink)' }}>裁判记录</b><MarkdownText text={m.content} />{m.streaming && <span className="caret" />}</div>
              </div>
            )
          }
          return <div key={m.id} style={{ gridColumn: '1 / -1', position: 'relative', zIndex: 1, background: '#fff' }}><Chat m={m} room={room} all={messages} /></div>
        })}
      </div>
      <PendingList pending={pending} seats={room.seats} />
    </>
  )
}
