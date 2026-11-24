import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { RunFile, RunLanguage } from '../api'
import { Icon } from './Icon'

/**
 * 运行预览：把模型发言里的 HTML / JS 代码放进沙箱 iframe 运行。
 *
 * 安全：iframe 只开 allow-scripts（不开 allow-same-origin），页面是不透明来源，
 * 拿不到本站 Cookie、读不到父页面；再用 CSP 禁止 fetch / XHR / WebSocket 和表单提交。
 * 沙箱里 localStorage 不可用，所以注入一个替身：数据存在父页面内存里，
 * "重新运行"时带回去，可以测试"刷新后最高分还在"。
 */

export type RunLang = 'html' | 'js'
export interface Block { lang: string; code: string }
export interface RunRequest {
  lang: RunLang
  code: string
  /** 同一条发言里的其他代码块，HTML 缺 CSS / JS 时自动补上 */
  siblings: Block[]
  authorId: string | null
  authorName: string
}

interface LogLine { level: 'log' | 'info' | 'warn' | 'error'; text: string }

/** 在服务器沙箱运行（契约第 4.5 节）。replyTo 是代码来源那条消息的 id */
export type ServerRun = (language: RunLanguage, files: RunFile[], replyTo?: string) => void
interface RunnerApi {
  preview: (r: RunRequest) => void
  /** 服务器没有启用代码运行时为 undefined */
  serverRun?: ServerRun
}
const RunnerCtx = createContext<RunnerApi | null>(null)
export const useRunner = () => useContext(RunnerCtx)

/** 代码块语言 → 服务器能运行的语言 */
export function serverLang(lang: string): RunLanguage | null {
  const l = lang.toLowerCase()
  if (l === 'python' || l === 'py' || l === 'python3') return 'python'
  if (l === 'js' || l === 'javascript' || l === 'mjs' || l === 'node' || l === 'nodejs') return 'node'
  return null
}

/** 把 html 里引用的同批文件（<script src> / <link href>）内联进去，iframe 的 srcdoc 读不到相对路径 */
export function inlineFiles(files: RunFile[]): string {
  const [entry, ...rest] = files
  const byPath = new Map(rest.map((f) => [f.path.replace(/^\.\//, ''), f.content]))
  const norm = (p: string) => p.replace(/^\.\//, '')
  return entry.content
    .replace(/<script([^>]*?)\ssrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, (all, a: string, src: string, b: string) =>
      byPath.has(norm(src)) ? `<script${a}${b}>${byPath.get(norm(src))}</script>` : all)
    .replace(/<link([^>]*?)\shref=["']([^"']+)["']([^>]*)>/gi, (all, a: string, href: string, b: string) =>
      /stylesheet/i.test(a + b) && byPath.has(norm(href)) ? `<style>${byPath.get(norm(href))}</style>` : all)
}

export function runLang(lang: string): RunLang | null {
  const l = lang.toLowerCase()
  if (l === 'html' || l === 'htm' || l === 'xhtml') return 'html'
  if (l === 'js' || l === 'javascript' || l === 'mjs') return 'js'
  return null
}

/** 拼出要运行的完整页面（不含注入的监控脚本） */
export function buildPage(req: Pick<RunRequest, 'lang' | 'code' | 'siblings'>): string {
  if (req.lang === 'js') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>${req.code}\n</script></body></html>`
  }
  let html = req.code
  const css = req.siblings.filter((b) => b.lang.toLowerCase() === 'css').map((b) => b.code)
  const js = req.siblings.filter((b) => runLang(b.lang) === 'js').map((b) => b.code)
  if (css.length && !/<style[\s>]/i.test(html)) {
    // 不加换行，免得报错里的行号和模型写的代码对不上；CSS 的换行换成空格不影响效果
    const tag = `<style>${css.join(' ').replace(/\s*\n\s*/g, ' ')}</style>`
    html = /<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html
  }
  if (js.length && !/<script[\s>]/i.test(html)) {
    const tag = `<script>\n${js.join('\n')}\n</script>`
    html = /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, `${tag}\n</body>`) : html + '\n' + tag
  }
  return html
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https: blob:",
  "style-src 'unsafe-inline' https:",
  'img-src data: blob: https:',
  'font-src data: https:',
  'media-src data: blob: https:',
  "connect-src 'none'",
  "form-action 'none'",
].join('; ')

/** 监控脚本：转发控制台、报错和 localStorage 改动。写成一行，不改变用户代码的行号 */
function monitor(token: string, store: Record<string, string>): string {
  const src = `(function(){var T=${JSON.stringify(token)},P=parent;function S(t,d){try{P.postMessage({__rt:T,type:t,data:d},'*')}catch(e){}}
function F(a){try{if(a instanceof Error)return a.name+': '+a.message;if(typeof a==='object')return JSON.stringify(a);return String(a)}catch(e){return String(a)}}
['log','info','warn','error','debug'].forEach(function(k){var o=console[k];console[k]=function(){S('log',{level:k==='debug'?'log':k,text:[].map.call(arguments,F).join(' ')});try{o.apply(console,arguments)}catch(e){}}});
addEventListener('error',function(e){if(e.target&&e.target!==window&&(e.target.src||e.target.href)){S('log',{level:'error',text:'资源加载失败：'+(e.target.src||e.target.href)});return}S('log',{level:'error',text:(e.message||'脚本错误')+(e.lineno?'（第 '+e.lineno+' 行）':'')})},true);
addEventListener('unhandledrejection',function(e){S('log',{level:'error',text:'未处理的 Promise 错误：'+F(e.reason)})});
function M(init,sync){var d=Object.assign({},init);var s={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v);sync&&S('storage',d)},removeItem:function(k){delete d[String(k)];sync&&S('storage',d)},clear:function(){d={};sync&&S('storage',d)},key:function(i){return Object.keys(d)[i]||null}};Object.defineProperty(s,'length',{get:function(){return Object.keys(d).length}});return s}
try{Object.defineProperty(window,'localStorage',{value:M(${JSON.stringify(store)},true),configurable:true})}catch(e){}
try{Object.defineProperty(window,'sessionStorage',{value:M({},false),configurable:true})}catch(e){}
addEventListener('load',function(){S('ready',null)})})();`
  return `<meta http-equiv="Content-Security-Policy" content="${CSP}"><script>${src.replace(/\n/g, '')}</script>`
}

/** 把监控脚本插到 <head> 开头；没有 head 就放在 doctype / html 标签之后，保持标准模式和行号 */
export function instrument(page: string, token: string, store: Record<string, string>): string {
  const inj = monitor(token, store)
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const m = page.match(re)
    if (m && m.index != null) return page.slice(0, m.index + m[0].length) + inj + page.slice(m.index + m[0].length)
  }
  return inj + page
}

interface ProviderProps {
  children: ReactNode
  /** 把运行结果发回房间；不传则不显示"发回房间" */
  onReport?: (text: string, mentions: string[]) => void
  /** 在服务器沙箱运行；服务器没启用代码运行时不传 */
  serverRun?: ServerRun
}

export function RunnerProvider({ children, onReport, serverRun }: ProviderProps) {
  const [req, setReq] = useState<RunRequest | null>(null)
  const preview = useCallback((r: RunRequest) => setReq(r), [])
  const value = useMemo(() => ({ preview, serverRun }), [preview, serverRun])
  return (
    <RunnerCtx.Provider value={value}>
      {children}
      {req && <RunnerSheet req={req} onClose={() => setReq(null)} onReport={onReport} />}
    </RunnerCtx.Provider>
  )
}

const MAX_LOGS = 200

function RunnerSheet({ req, onClose, onReport }: { req: RunRequest; onClose: () => void; onReport?: ProviderProps['onReport'] }) {
  const page = useMemo(() => buildPage(req), [req])
  const [run, setRun] = useState(0)
  const [logs, setLogs] = useState<LogLine[]>([])
  const [note, setNote] = useState('')
  const store = useRef<Record<string, string>>({})
  const frame = useRef<HTMLIFrameElement>(null)
  // 每次运行换一个口令，旧 iframe 的迟到消息不会混进来
  const token = useMemo(() => `rt_${run}_${Math.random().toString(36).slice(2)}`, [run])
  const srcDoc = useMemo(() => instrument(page, token, store.current), [page, token])

  useEffect(() => {
    function onMsg(e: MessageEvent) {
      const d = e.data
      if (!d || d.__rt !== token || e.source !== frame.current?.contentWindow) return
      if (d.type === 'log') setLogs((l) => (l.length >= MAX_LOGS ? l : [...l, { level: d.data.level, text: String(d.data.text).slice(0, 800) }]))
      else if (d.type === 'storage') store.current = { ...d.data }
      else if (d.type === 'ready') frame.current?.contentWindow?.focus()
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [token])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function rerun() { setLogs([]); setRun((n) => n + 1) }
  function clearStore() { store.current = {}; rerun() }
  function download() {
    const url = URL.createObjectURL(new Blob([page], { type: 'text/html' }))
    const a = document.createElement('a')
    a.href = url
    a.download = req.lang === 'js' ? 'script.html' : 'page.html'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function report() {
    if (!onReport) return
    const errors = logs.filter((l) => l.level === 'error')
    const warns = logs.filter((l) => l.level === 'warn')
    const lines = [`${req.authorId ? `@${req.authorName} ` : ''}我运行了${req.authorName}的代码。`]
    lines.push(errors.length ? `报错 ${errors.length} 条：\n${errors.slice(0, 10).map((l) => `- ${l.text}`).join('\n')}` : '没有报错。')
    if (warns.length) lines.push(`警告 ${warns.length} 条：\n${warns.slice(0, 5).map((l) => `- ${l.text}`).join('\n')}`)
    const out = logs.filter((l) => l.level === 'log' || l.level === 'info')
    if (out.length) lines.push(`控制台输出（前 ${Math.min(out.length, 10)} 条）：\n${out.slice(0, 10).map((l) => `- ${l.text}`).join('\n')}`)
    if (note.trim()) lines.push(`我的观察：${note.trim()}`)
    onReport(lines.join('\n'), req.authorId ? [req.authorId] : [])
    onClose()
  }

  const errCount = logs.filter((l) => l.level === 'error').length
  return (
    <div className="scrim" onClick={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="sheet runner" role="dialog" aria-modal="true" aria-labelledby="runnerTitle">
        <div className="sheet-head">
          <h2 id="runnerTitle">运行预览<span className="faint" style={{ fontSize: 14, fontWeight: 500, marginLeft: 8 }}>{req.authorName} 的代码</span></h2>
          <button className="icon-btn" onClick={onClose} aria-label="关闭"><Icon name="x" /></button>
        </div>
        <div className="runner-body">
          <iframe key={run} ref={frame} title="运行预览" className="runner-frame" sandbox="allow-scripts allow-modals allow-pointer-lock" srcDoc={srcDoc} />
          <div className="runner-console" aria-label="控制台" aria-live="polite">
            <div className="runner-console-head">
              控制台{errCount ? <span className="error-text">　{errCount} 条报错</span> : logs.length ? '' : <span className="faint">　暂无输出</span>}
              {logs.length >= MAX_LOGS && <span className="faint">　（只显示前 {MAX_LOGS} 条）</span>}
            </div>
            {logs.map((l, i) => <div key={i} className={`runner-log ${l.level}`}>{l.text}</div>)}
          </div>
          <p className="faint" style={{ fontSize: 12, margin: '8px 0 0' }}>
            代码运行在隔离的沙箱里：不能联网请求数据，也碰不到本站账号。本地保存（localStorage）只在这次预览期间有效，点"重新运行"会保留，用来测试刷新后的效果。
          </p>
        </div>
        <div className="sheet-foot runner-foot">
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-quiet" onClick={rerun}><Icon name="play" size={13} />重新运行</button>
            <button className="btn btn-quiet" onClick={clearStore} title="清空本地保存的数据后重新运行">清空保存的数据</button>
            <button className="btn btn-quiet" onClick={download} title="下载成 .html 文件，用浏览器直接打开">下载</button>
          </div>
          {onReport && (
            <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 260, justifyContent: 'flex-end' }}>
              <input className="input" style={{ flex: 1, maxWidth: 320 }} placeholder="补充你看到的问题（可选）" value={note}
                onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') report() }} aria-label="补充说明" />
              <button className="btn btn-ink" onClick={report} title="把报错和你的说明发到房间里，作者会接着修改">发回房间</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
