import { useEffect, useLayoutEffect, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Avatar } from '../components/Avatar'
import { Composer } from '../components/Composer'
import { Icon } from '../components/Icon'
import { CrossView, DebateView, PipeView, RoundView } from '../components/ModeViews'
import { RoundTable } from '../components/RoundTable'
import { DUTY_NAME, MODE_NAME, STATUS_NAME, yuan } from '../labels'
import { useRoom } from '../state/useRoom'
import { useToast } from '../state/toast'

export function RoomPage() {
  const { id = '' } = useParams()
  const r = useRoom(id)
  const toast = useToast()
  const stageRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  // 只有用户本来就在底部时才自动滚动，避免看历史时被拽下去
  const onScroll = () => {
    const el = stageRef.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  useLayoutEffect(() => {
    const el = stageRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [r.messages, r.pending])
  useEffect(() => { stick.current = true }, [id])

  if (r.loadError) return <div className="center-fill"><div>{r.loadError}　<Link to="/rooms">返回房间列表</Link></div></div>
  if (!r.room) return <div className="center-fill">正在进入房间…</div>

  const room = r.room
  const st = r.state
  const status = st?.status ?? room.status
  const speaker = room.seats.find((s) => s.id === st?.speaker_id) ?? null
  const next = room.seats.find((s) => s.id === st?.next_speaker_id) ?? null
  const humans = room.seats.filter((s) => s.kind === 'human').length
  const disconnected = r.conn.status === 'reconnecting' || r.conn.status === 'closed'

  const View = { round: RoundView, pipe: PipeView, cross: CrossView, debate: DebateView }[room.mode]
  const progress = !st ? '' : room.mode === 'pipe' ? '流水线' : room.mode === 'cross'
    ? ({ answer: '各自回答', review: '匿名互评', verdict: '裁判汇总', done: '已出结论' } as const)[st.mode_state.phase ?? 'answer']
    : st.round > 0 ? `第 ${st.round} / ${st.total_rounds} ${room.mode === 'debate' ? '回合' : '轮'}` : '未开始'

  const act = (type: 'start' | 'pause' | 'resume' | 'interrupt' | 'skip', msg?: string) => { r.send({ type }); if (msg) toast(msg) }

  return (
    <div className="room">
      <div className="room-main">
        <div className="toolbar">
          <Link className="icon-btn" to="/rooms" aria-label="返回房间列表"><Icon name="back" /></Link>
          <div className="grow">
            <h2>{room.title}</h2>
            <div className="sub">{MODE_NAME[room.mode]} · {humans} 位朋友，{room.seats.length - humans} 个模型 · 已花费 {yuan(st?.cost_cny ?? room.cost_cny)}（预估）</div>
          </div>
          <span className={`status-pill ${status}`}>{STATUS_NAME[status]}</span>
          <div className="room-ctrls">
            {status === 'idle' && <button className="btn btn-ink" onClick={() => act('start')}><Icon name="play" size={14} /><span className="lbl">开始</span></button>}
            {status === 'running' && <>
              <button className="btn btn-quiet" onClick={() => act('pause', '当前发言说完后暂停')} title="等当前发言说完再暂停"><Icon name="pause" size={14} /><span className="lbl">暂停</span></button>
              <button className="btn btn-quiet" disabled={!speaker} onClick={() => act('interrupt')} title="立刻截断当前发言并暂停"><Icon name="stop" size={14} /><span className="lbl">打断</span></button>
              <button className="btn btn-quiet" disabled={!speaker} onClick={() => act('skip')} title="截断当前发言，轮到下一位"><Icon name="skip" size={14} /><span className="lbl">跳过</span></button>
            </>}
            {status === 'paused' && <button className="btn btn-ink" onClick={() => act('resume')}><Icon name="play" size={14} /><span className="lbl">继续</span></button>}
            {status === 'finished' && room.mode === 'round' && <button className="btn btn-quiet" onClick={() => act('start')}><Icon name="plus" size={14} /><span className="lbl">再来一轮</span></button>}
          </div>
        </div>
        {disconnected && <div className="conn-banner">{r.conn.reason ?? '连接断开，正在重连…'}</div>}

        <div className="stage" ref={stageRef} onScroll={onScroll}>
          <div className="stage-inner">
            <View room={room} messages={r.messages} state={st} pending={r.pending} />
          </div>
        </div>

        <div className="interrupt-bar">
          {speaker ? (
            <span className="speaking">
              <span className="wave" style={{ ['--seat' as string]: speaker.color }}><i /><i /><i /></span>
              {speaker.name} 正在发言{next && next.id !== speaker.id ? `，下一位是 ${next.name}` : ''}
            </span>
          ) : status === 'paused' ? <span>已暂停，点"继续"或先插话</span>
            : status === 'budget_exceeded' ? <span style={{ color: 'var(--bad)' }}>预算已用完，讨论停止</span> : null}
        </div>
        <Composer seats={room.seats} disabled={r.conn.status === 'closed'}
          onSay={(c, m) => { r.say(c, m); if (m.length) toast(`${room.seats.find((s) => s.id === m[0])?.name} 会在下一个发言`) }}
          onSteer={(c) => { r.send({ type: 'steer', content: c }); toast('方向指示已生效') }} />
      </div>

      <aside className="inspector" aria-label="房间状态">
        <div className="table-wrap">
          <RoundTable seats={room.seats} active={speaker?.id ?? null}
            center={<text x={140} y={129} textAnchor="middle" fontSize={11.5} fontWeight={600} fill="#55555B">{progress}</text>} />
          <div className="now">
            {speaker ? <><b>{speaker.name}</b> 正在发言</> : status === 'paused' ? '整张桌子已暂停' : status === 'finished' ? '讨论已结束' : status === 'idle' ? '还没开始' : '没有人在发言'}
          </div>
        </div>
        <div className="ins-block">
          <h5>本房间预算<span className="num">{yuan(st?.cost_cny ?? room.cost_cny)} / {yuan(st?.budget_cny ?? room.budget_cny)}</span></h5>
          <div className="meter"><i style={{ width: `${Math.min(100, ((st?.cost_cny ?? 0) / (st?.budget_cny || 1)) * 100)}%`, background: (st?.cost_cny ?? 0) / (st?.budget_cny || 1) > 0.85 ? 'var(--warn)' : undefined }} /></div>
          <div className="kv" style={{ marginTop: 10 }}><span>上下文</span><b className="num">{((st?.context_tokens ?? 0) / 1000).toFixed(1)}k tokens</b></div>
          <div className="kv"><span>早期发言已摘要</span><b>{st?.summarized_until_round ? `前 ${st.summarized_until_round} 轮` : '无'}</b></div>
        </div>
        <div className="ins-block">
          <h5>桌上成员<span>输入 @ 可以点名</span></h5>
          {room.seats.map((s) => (
            <div className="member-mini" key={s.id}>
              <Avatar {...s} size="sm" />{s.name}
              <span className="r">{s.kind === 'ai' ? `${s.duty ? DUTY_NAME[s.duty] : ''}${s.role ? ` · ${s.role}` : ''}` : r.online.includes(s.id) ? '在线' : '离线'}</span>
            </div>
          ))}
        </div>
      </aside>
    </div>
  )
}
