import { createContext, useContext, useState, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import type { Message, MessageMeta, Seat } from '../api'
import { yuan } from '../labels'
import { useSession } from '../state/session'
import { Avatar } from './Avatar'
import { runLang, serverLang, useRunner, type Block } from './CodeRunner'
import { RunCard } from './RunCard'

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

interface HastText { type: 'text'; value: string }
interface HastEl { type: 'element'; tagName: string; properties?: { className?: string[] }; children?: (HastEl | HastText)[] }
const hastText = (n: HastEl | HastText): string => (n.type === 'text' ? n.value : (n.children ?? []).map(hastText).join(''))

/** 从 Markdown 原文里取出所有围栏代码块，给"运行"时拼接同一条发言里的 CSS / JS 用 */
function fencedBlocks(text: string): Block[] {
  const out: Block[] = []
  const re = /^ {0,3}(`{3,}|~{3,})[ \t]*([\w+#.-]*)[^\n]*\n([\s\S]*?)^ {0,3}\1[ \t]*$/gm
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ lang: m[2] || '', code: m[3].replace(/\n$/, '') })
  return out
}

export interface RunSource { authorId: string | null; authorName: string; messageId?: string }

const MdCtx = createContext<{ text: string; source?: RunSource }>({ text: '' })

function CodeBlock({ node, children }: { node?: HastEl; children?: ReactNode }) {
  const { text, source } = useContext(MdCtx)
  const runner = useRunner()
  const [copied, setCopied] = useState(false)
  const codeEl = node?.children?.find((c): c is HastEl => c.type === 'element' && c.tagName === 'code')
  const lang = (codeEl?.properties?.className ?? []).find((c) => c.startsWith('language-'))?.slice(9) ?? ''
  const code = codeEl ? hastText(codeEl).replace(/\n$/, '') : ''
  const rl = runLang(lang)
  const sl = serverLang(lang)
  const ready = !!(runner && source && code.trim())
  const canRun = ready && !!rl
  const canServer = ready && !!sl && !!runner?.serverRun
  function copy() {
    navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return (
    <div className="code-block">
      <div className="code-bar">
        <span className="code-lang">{lang || '代码'}</span>
        <button className="code-btn" onClick={copy}>{copied ? '已复制' : '复制'}</button>
        {canServer && (
          <button className="code-btn" title="在服务器的隔离沙箱里运行，结果会发到房间里，模型也能看到"
            onClick={() => runner!.serverRun!(sl!, [{ path: sl === 'python' ? 'main.py' : 'main.js', content: code }], source!.messageId)}>
            在服务器运行
          </button>
        )}
        {canRun && (
          <button className="code-btn run" title="在浏览器里预览运行"
            onClick={() => runner!.preview({ lang: rl!, code, siblings: fencedBlocks(text), authorId: source!.authorId, authorName: source!.authorName })}>
            运行
          </button>
        )}
      </div>
      <pre>{children}</pre>
    </div>
  )
}

/** source：发言作者。传了且消息已输出完，HTML / JS 代码块才显示"运行" */
export function MarkdownText({ text, source }: { text: string; source?: RunSource }) {
  return (
    <MdCtx.Provider value={{ text, source }}>
      <div className="md"><Markdown components={MD_COMPONENTS}>{text}</Markdown></div>
    </MdCtx.Provider>
  )
}
const MD_COMPONENTS: Components = { pre: ({ node, children }) => <CodeBlock node={node as unknown as HastEl}>{children}</CodeBlock> }

interface Props {
  m: Pick<Message, 'author_id' | 'kind' | 'content' | 'cost_cny' | 'interrupted' | 'streaming' | 'reply_to'> & { id?: string; meta?: MessageMeta }
  seats: Seat[]
  replyName?: string | null
  pending?: boolean
}

export function MessageItem({ m, seats, replyName, pending }: Props) {
  const { who } = useSession()
  if (m.kind === 'system') return <div className="sys-line">{m.content}</div>
  if (m.kind === 'run' && m.meta?.run) {
    return <RunCard run={m.meta.run} authorId={m.author_id} seats={seats} interrupted={m.interrupted} streaming={m.streaming}
      replyName={replyName} cost={m.cost_cny} />
  }
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
          {isAi ? <MarkdownText text={m.content} source={m.streaming || pending ? undefined : { authorId: m.author_id, authorName: p.name, messageId: m.id }} />
            : <HumanText text={m.content} seats={seats} />}
          {m.streaming && <span className="caret" />}
        </div>
        {m.interrupted && <div className="interrupted">（被打断）</div>}
      </div>
    </div>
  )
}
