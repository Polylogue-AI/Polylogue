import type { CodeRun, Seat } from '../api'
import { yuan } from '../labels'
import { useSession } from '../state/session'
import { Avatar } from './Avatar'
import { inlineFiles, useRunner } from './CodeRunner'

const STATUS: Record<CodeRun['status'], { label: string; tone: 'run' | 'ok' | 'bad' | 'mute' }> = {
  queued: { label: '排队中…', tone: 'run' },
  running: { label: '运行中…', tone: 'run' },
  ok: { label: '成功', tone: 'ok' },
  error: { label: '失败', tone: 'bad' },
  timeout: { label: '超时', tone: 'bad' },
  cancelled: { label: '已取消', tone: 'mute' },
  unavailable: { label: '运行环境不可用', tone: 'mute' },
}
const LANG = { python: 'Python', node: 'Node.js', html: '网页' } as const

/** 一次代码运行（kind: 'run'），发起者可以是 AI 也可以是人 */
export function RunCard({ run, authorId, seats, interrupted, streaming, replyName, cost, bare }: {
  run: CodeRun
  authorId: string | null
  seats: Seat[]
  interrupted: boolean
  streaming: boolean
  replyName?: string | null
  /** AI 的某次调用只有工具调用、没有文字时，费用记在 run 消息上 */
  cost?: number | null
  /** 只要卡片本体（嵌在交叉验证的回答卡片里时用） */
  bare?: boolean
}) {
  const { who } = useSession()
  const runner = useRunner()
  const seat = seats.find((s) => s.id === authorId)
  const p = seat ?? who(authorId)
  const st = STATUS[run.status] ?? { label: run.status, tone: 'mute' as const }
  const entry = run.files[0]
  const label = run.exit_code != null && run.status !== 'ok' ? `${st.label}，退出码 ${run.exit_code}` : st.label
  const output = [
    run.stdout && { title: '输出', text: run.stdout, bad: false },
    run.stderr && { title: '错误输出', text: run.stderr, bad: true },
    run.page_errors.length > 0 && { title: '页面报错', text: run.page_errors.join('\n'), bad: true },
    run.console.length > 0 && { title: '页面控制台', text: run.console.map((l) => `${l.level === 'log' ? '' : `[${l.level}] `}${l.text}`).join('\n'), bad: false },
  ].filter((x): x is { title: string; text: string; bad: boolean } => !!x)
  const done = !streaming && run.status !== 'queued' && run.status !== 'running'

  const card = (
    <div className="run-card">
      <div className="run-head">
        <span className="run-lang">{LANG[run.language] ?? run.language}</span>
        <code className="run-entry">{entry?.path ?? ''}{run.files.length > 1 ? ` 等 ${run.files.length} 个文件` : ''}</code>
        <span className={`run-status ${st.tone}`}>{st.tone === 'run' && <i className="run-spin" />}{label}</span>
        {run.duration_ms != null && <span className="run-time num">{(run.duration_ms / 1000).toFixed(1)} 秒</span>}
      </div>
      <details className="run-code">
        <summary>查看代码{run.test ? '和测试脚本' : ''}</summary>
        {run.files.map((f) => (
          <div key={f.path}><div className="run-file">{f.path}</div><pre><code>{f.content}</code></pre></div>
        ))}
        {run.test && <div><div className="run-file">测试脚本（Playwright）</div><pre><code>{run.test}</code></pre></div>}
      </details>
      {done && (output.length ? output.map((o) => (
        <div key={o.title} className="run-out">
          <div className="run-out-title">{o.title}</div>
          <pre className={o.bad ? 'bad' : ''}>{o.text}</pre>
        </div>
      )) : <div className="run-out faint">没有输出</div>)}
      {done && run.truncated && <div className="faint run-note">输出太长，中间部分已省略</div>}
      {done && run.language === 'html' && entry && runner && (
        <div className="run-actions">
          <button className="code-btn run" onClick={() => runner.preview({
            lang: 'html', code: inlineFiles(run.files), siblings: [], authorId, authorName: p?.name ?? '某人',
          })}>在浏览器里预览</button>
        </div>
      )}
    </div>
  )
  if (bare) return card

  return (
    <div className={`msg run-msg ${p?.kind ?? 'ai'}`} style={{ ['--seat' as string]: p?.color ?? 'var(--ink-3)' }}>
      {p && <Avatar name={p.name} short={p.short} color={p.color} kind={p.kind} />}
      <div className="body">
        <div className="who">
          <b>{p?.name ?? '某人'}</b><span className="role">运行代码</span>
          {cost != null && cost > 0 && <span className="cost num" title="预估费用（这次模型调用的费用）">{yuan(cost, 3)}</span>}
        </div>
        {replyName && <div className="reply-to">运行 {replyName} 的代码</div>}
        {card}
        {interrupted && <div className="interrupted">（被打断）</div>}
      </div>
    </div>
  )
}
