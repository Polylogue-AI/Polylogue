import { useCallback, useEffect, useState } from 'react'
import { api, type Invite, type ModelOption, type SandboxStatus } from '../api'
import { Avatar } from '../components/Avatar'
import { Icon } from '../components/Icon'
import { useSession } from '../state/session'
import { useToast } from '../state/toast'

const PROVIDER: Record<string, { name: string; color: string; short: string }> = {
  anthropic: { name: 'Anthropic', color: 'var(--c-claude)', short: 'A' },
  openai: { name: 'OpenAI', color: 'var(--c-gpt)', short: 'O' },
  gemini: { name: 'Google Gemini', color: 'var(--c-gemini)', short: 'G' },
  deepseek: { name: 'DeepSeek', color: 'var(--c-deepseek)', short: 'D' },
  dashscope: { name: '通义千问', color: 'var(--c-qwen)', short: 'Q' },
  ollama: { name: 'Ollama 本地', color: 'var(--c-ollama)', short: 'L' },
}

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })

export function SettingsPage() {
  const { user, users } = useSession()
  const toast = useToast()
  const [models, setModels] = useState<ModelOption[]>([])
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)
  const [invites, setInvites] = useState<Invite[] | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [fresh, setFresh] = useState<string | null>(null)

  const loadInvites = useCallback(() => api.invites().then(setInvites).catch((e) => toast(e.message)), [toast])
  useEffect(() => { api.models().then(setModels).catch(() => {}) }, [])
  useEffect(() => { api.sandbox().then(setSandbox).catch(() => {}) }, [])
  useEffect(() => { if (user?.is_admin) loadInvites() }, [user, loadInvites])

  const providers = [...new Set(models.map((m) => m.provider))]

  async function create() {
    setBusy(true)
    try {
      const inv = await api.createInvite(note.trim())
      setNote('')
      setFresh(inv.code)
      await loadInvites()
      copy(inv.code)
    } catch (e) {
      toast((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function revoke(code: string) {
    if (!confirm(`作废邀请码 ${code}？作废后不能再用它登录。`)) return
    try {
      await api.revokeInvite(code)
      await loadInvites()
      toast('已作废')
    } catch (e) {
      toast((e as Error).message)
    }
  }
  function copy(code: string) {
    navigator.clipboard?.writeText(code).then(() => toast(`邀请码 ${code} 已复制`), () => toast(`邀请码：${code}`))
  }

  return (
    <section className="view">
      <div className="page" style={{ maxWidth: 860 }}>
        <div className="page-head"><div><h1>设置</h1><p>这些设置对整个团队生效。{user?.is_admin ? '' : '只有管理员能修改。'}</p></div></div>

        <div className="settings-sec">
          <h2 className="settings-h">模型服务</h2>
          <div className="group">
            {providers.map((p) => {
              const list = models.filter((m) => m.provider === p)
              const ok = list.filter((m) => m.available).length
              const meta = PROVIDER[p] ?? { name: p, color: 'var(--ink-3)', short: p.slice(0, 1).toUpperCase() }
              return (
                <div className="group-row" key={p}>
                  <span className="provider-logo" style={{ background: meta.color }}>{meta.short}</span>
                  <div className="grow">{meta.name}<small>{list.map((m) => m.label).join('、')}</small></div>
                  <span className="key-state">
                    <i style={{ background: ok ? 'var(--ok)' : 'var(--bad)' }} />
                    {ok === list.length ? '可用' : ok ? `${ok} / ${list.length} 可用` : 'Key 未配置或检测失败'}
                  </span>
                </div>
              )
            })}
            {!providers.length && <div className="group-row faint">加载中…</div>}
          </div>
          <p className="group-note">
            <Icon name="warn" size={13} style={{ verticalAlign: -2 }} /> API Key 只保存在服务器的 <code>backend/.env</code> 里，浏览器拿不到。要添加或更换 Key，请编辑服务器上的这个文件后重启后端。
          </p>
        </div>

        <div className="settings-sec">
          <h2 className="settings-h">代码运行</h2>
          <div className="group">
            <div className="group-row">
              <span className="provider-logo" style={{ background: 'var(--ink-2)' }}>&lt;/&gt;</span>
              <div className="grow">
                Docker 沙箱
                <small>{!sandbox ? '检测中…'
                  : sandbox.available ? `可运行：${sandbox.languages.map((l) => ({ python: 'Python', node: 'Node.js', html: '网页' })[l]).join('、')}`
                  : sandbox.enabled ? sandbox.reason ?? '暂不可用'
                  : '未启用。在 backend/.env 里设置 SANDBOX_ENABLED=1 并重启后端'}</small>
              </div>
              <span className="key-state">
                <i style={{ background: sandbox?.available ? 'var(--ok)' : sandbox?.enabled ? 'var(--bad)' : 'var(--ink-4, #C7C7CC)' }} />
                {!sandbox ? '' : sandbox.available ? '可用' : sandbox.enabled ? '不可用' : '未启用'}
              </span>
            </div>
          </div>
          <p className="group-note">
            每次运行都在一个新的隔离容器里进行：不能联网，限时、限内存，用完即删。要让某位模型成员自己运行代码，在"成员"页打开它的"允许运行代码"。
          </p>
        </div>

        <div className="settings-sec">
          <h2 className="settings-h">朋友与邀请</h2>
          <div className="group">
            {users.map((u) => (
              <div className="group-row" key={u.id}>
                <Avatar {...u} kind="human" />
                <div className="grow">{u.name}<small>{u.monthly_limit_cny == null ? '每月不限额' : `每月上限 ¥${u.monthly_limit_cny}`}</small></div>
                <span className="faint" style={{ fontSize: 12.5 }}>{u.is_admin ? '管理员' : '成员'}</span>
              </div>
            ))}
          </div>

          {user?.is_admin ? (
            <>
              <div className="group" style={{ marginTop: 16 }}>
                <div className="group-row">
                  <div className="grow">生成邀请码<small>7 天内有效，第一次登录时绑定名字，之后这个人可以一直用它登录</small></div>
                  <input className="input" style={{ width: 180 }} placeholder="备注，例如：给小雨" value={note} maxLength={40}
                    onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') create() }} aria-label="邀请码备注" />
                  <button className="btn btn-ink" onClick={create} disabled={busy}>{busy ? '生成中…' : '生成'}</button>
                </div>
                {invites?.map((inv) => {
                  const expired = !inv.used_by && new Date(inv.expires_at).getTime() < Date.now()
                  const owner = inv.used_by ? users.find((u) => u.id === inv.used_by)?.name ?? '某人' : null
                  return (
                    <div className="group-row" key={inv.code} style={inv.code === fresh ? { background: 'var(--signal-soft)' } : undefined}>
                      <span className="invite-code" style={expired ? { opacity: 0.45, textDecoration: 'line-through' } : undefined}>{inv.code}</span>
                      <div className="grow">
                        {inv.note || <span className="faint">无备注</span>}
                        <small>{owner ? `已被 ${owner} 使用` : expired ? `${fmtDate(inv.expires_at)} 已过期` : `${fmtDate(inv.created_at)} 生成，${fmtDate(inv.expires_at)} 前有效`}</small>
                      </div>
                      {!owner && !expired && <button className="btn btn-quiet" onClick={() => copy(inv.code)}>复制</button>}
                      {!owner && <button className="btn btn-quiet" style={{ color: 'var(--bad)' }} onClick={() => revoke(inv.code)}>作废</button>}
                    </div>
                  )
                })}
                {invites && !invites.length && <div className="group-row faint" style={{ fontSize: 13 }}>还没有生成过邀请码</div>}
              </div>
              <p className="group-note">已使用的邀请码不能作废。要移除一个人，目前需要在服务器上操作。</p>
            </>
          ) : (
            <p className="group-note" style={{ marginTop: 12 }}>需要邀请朋友加入时，请联系管理员生成邀请码。</p>
          )}
        </div>
      </div>
    </section>
  )
}
