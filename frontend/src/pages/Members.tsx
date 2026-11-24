import { useEffect, useState } from 'react'
import { api, type AiMember, type AiMemberInput, type ModelOption, type SandboxStatus } from '../api'
import { Avatar } from '../components/Avatar'
import { Icon } from '../components/Icon'
import { yuan } from '../labels'
import { useSession } from '../state/session'
import { useToast } from '../state/toast'

const PRESETS: Record<string, string> = {
  产品顾问: '你是产品顾问。先判断用户真正要解决的问题，再给建议。',
  工程评估: '你是工程评估。从实现难度、时间、维护成本三个方面评估方案，给出具体的工作量估计。',
  用户研究: '你是用户研究员。用真实用户行为和数据说话，没有数据时明确说"这是假设"。',
  唱反调: '你是唱反调的人。找出前面所有观点里最薄弱的地方并反驳，不要附和任何人。',
  中文写作: '你负责中文写作。语言简洁、准确，避免空话和套话，术语前后统一。',
  草稿员: '你是草稿员。快速写出第一版，不追求完美，后面会有人审查。',
  审查者: '你是审查者。逐条核对事实、引用和逻辑，只指出问题和修改建议，不重写全文。',
  汇总者: '你是汇总者。整理讨论中的共识、分歧和下一步行动，不加入自己的新观点。',
}
const CUSTOM = '__custom__'
const COLORS = ['#C9842F', '#14996F', '#3C78F0', '#36458F', '#8659E8', '#3A3A3E', '#D6453D', '#0E8A9A']

export function MembersPage() {
  const { members, users, refresh, user } = useSession()
  const toast = useToast()
  const [models, setModels] = useState<ModelOption[]>([])
  const [cur, setCur] = useState<string | null>(null)
  const [form, setForm] = useState<AiMemberInput | null>(null)
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState(false)
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null)

  useEffect(() => { api.models().then(setModels).catch(() => {}) }, [])
  useEffect(() => { api.sandbox().then(setSandbox).catch(() => {}) }, [])
  useEffect(() => { if (!cur && members.length) setCur(members[0].id) }, [members, cur])
  const m = members.find((x) => x.id === cur) ?? null
  useEffect(() => {
    if (!m) return setForm(null)
    const { id: _id, month_cost_cny: _c, ...rest } = m
    setForm(rest)
    setCustom(false)
  }, [m])

  const set = <K extends keyof AiMemberInput>(k: K, v: AiMemberInput[K]) => setForm((f) => (f ? { ...f, [k]: v } : f))

  async function save() {
    if (!m || !form) return
    if (!form.name.trim()) return toast('名字不能为空')
    if (!/^[\w.-]+\/\S+$/.test(form.model.trim())) return toast('模型名的格式是"服务商/模型名"，例如 openai/gpt-5')
    setBusy(true)
    try {
      await api.updateMember(m.id, { ...form, model: form.model.trim(), name: form.name.trim(), short: form.short.trim() || form.name.trim().slice(0, 2) })
      await refresh()
      toast(`${form.name} 的设置已保存`)
    } catch (e) { toast((e as Error).message) } finally { setBusy(false) }
  }
  async function add() {
    // 优先选可用的模型；一个可用的都没有（例如后端刚启动还没检测过）时退回列表第一个
    const first = models.find((x) => x.available) ?? models[0]
    if (!first) return toast('模型列表还没加载出来，请稍后再试')
    try {
      const created: AiMember = await api.createMember({
        name: '新成员', short: '新', color: COLORS[members.length % COLORS.length], model: first.id, role: '产品顾问',
        system_prompt: PRESETS['产品顾问'], temperature: 0.6, max_chars: 300, monthly_budget_cny: 20, can_mention: false, can_run_code: false,
      })
      await refresh()
      setCur(created.id)
      toast('已添加新成员，先给它起个名字、选好模型')
    } catch (e) { toast((e as Error).message) }
  }
  async function remove() {
    if (!m || !confirm(`确定删除 ${m.name}？已有房间里的发言会保留。`)) return
    try {
      await api.deleteMember(m.id)
      setCur(null)
      await refresh()
      toast('已删除')
    } catch (e) { toast((e as Error).message) }
  }

  const model = models.find((x) => x.id === form?.model)
  // 不在列表里的模型（手动输入的）也按"手动输入"显示
  const manual = custom || (!!form && !!form.model && !model)
  // 后端没给这个字段时按支持处理
  const noTemp = model?.supports_temperature === false
  // 不能打开"允许运行代码"的原因；已经打开的仍可关闭
  const runBlock = !sandbox ? '正在检测运行环境…'
    : !sandbox.enabled ? '服务器没有启用代码运行（backend/.env 里的 SANDBOX_ENABLED）'
    : manual ? null
    : model?.supports_tools === false ? '这个模型不支持工具调用，不能运行代码' : null
  return (
    <section className="view">
      <div className="page">
        <div className="page-head">
          <div><h1>成员</h1><p>每个模型是桌上的一位成员。给它一个角色、一种说话的温度，以及花钱的上限。</p></div>
          {user?.is_admin && <button className="btn btn-ink" onClick={add}><Icon name="plus" size={15} />添加模型成员</button>}
        </div>
        <div className="members-layout">
          <div className="member-list" role="listbox" aria-label="模型成员">
            {members.map((x) => (
              <button key={x.id} className="member-item" role="option" aria-selected={x.id === cur} onClick={() => setCur(x.id)}>
                <Avatar {...x} kind="ai" />
                <div><b>{x.name}</b><span>{x.role}</span></div>
                <span className="budget-dot num">{x.monthly_budget_cny == null ? '不限' : yuan(x.monthly_budget_cny, 0)}</span>
              </button>
            ))}
            <div style={{ padding: '12px 10px 6px', fontSize: 12, color: 'var(--ink-3)', fontWeight: 600 }}>朋友</div>
            {users.map((u) => (
              <div key={u.id} className="member-item">
                <Avatar {...u} kind="human" />
                <div><b>{u.name}</b><span>{u.is_admin ? '管理员' : '朋友'}</span></div>
              </div>
            ))}
          </div>

          {m && form ? (
            <div className="editor">
              <div className="editor-head">
                <Avatar name={form.name} short={form.short} color={form.color} kind="ai" size="lg" />
                <div><h2>{form.name || '未命名'}</h2><span className="muted" style={{ fontSize: 13 }}>本月花费 {yuan(m.month_cost_cny)}（预估）</span></div>
              </div>
              <fieldset disabled={!user?.is_admin} style={{ border: 0 }}>
                <div className="form-grid">
                  <div className="field"><label htmlFor="f-name">名字</label><input className="input" id="f-name" value={form.name} onChange={(e) => set('name', e.target.value)} /></div>
                  <div className="field"><label htmlFor="f-short">头像文字（1–2 个字）</label><input className="input" id="f-short" maxLength={2} value={form.short} onChange={(e) => set('short', e.target.value)} /></div>
                  <div className="field">
                    <label htmlFor="f-model">模型</label>
                    <select className="select" id="f-model" value={manual ? CUSTOM : form.model}
                      onChange={(e) => {
                        if (e.target.value === CUSTOM) { setCustom(true); if (model) set('model', '') }
                        else { setCustom(false); set('model', e.target.value) }
                      }}>
                      {!form.model && !manual && <option value="">请选择</option>}
                      {models.map((x) => <option key={x.id} value={x.id}>{x.label}{x.available ? '' : '（Key 不可用）'}</option>)}
                      <option value={CUSTOM}>手动输入模型名…</option>
                    </select>
                    {manual && (
                      <>
                        <input className="input" aria-label="模型名" placeholder="例如 openai/gpt-6.1-sol" style={{ marginTop: 6 }}
                          value={form.model} onChange={(e) => set('model', e.target.value)} autoFocus={custom} />
                        <span className="faint" style={{ fontSize: 12 }}>写法和 LiteLLM 一致："服务商/模型名"。对应服务商的 Key 要先配置在 backend/.env 里</span>
                      </>
                    )}
                    {model && !model.available && <span className="error-text" style={{ fontSize: 12 }}>这个服务商的 Key 没配置或最近检测失败</span>}
                  </div>
                  <div className="field">
                    <label>身份色</label>
                    <div style={{ display: 'flex', gap: 6, paddingTop: 4 }}>
                      {COLORS.map((c) => (
                        <button key={c} aria-label={`颜色 ${c}`} aria-pressed={form.color === c} onClick={() => set('color', c)}
                          style={{ width: 24, height: 24, borderRadius: 7, background: c, boxShadow: form.color === c ? '0 0 0 2px #fff, 0 0 0 4px var(--ink)' : 'none' }} />
                      ))}
                    </div>
                  </div>
                  <div className="field full">
                    <label htmlFor="f-prompt">角色设定</label>
                    <textarea className="textarea" id="f-prompt" style={{ minHeight: 110 }} value={form.system_prompt} onChange={(e) => set('system_prompt', e.target.value)} />
                    <div className="preset-chips">
                      {Object.keys(PRESETS).map((k) => (
                        <button key={k} className="chip" aria-pressed={form.role === k} onClick={() => { set('role', k); set('system_prompt', PRESETS[k]) }}>{k}</button>
                      ))}
                    </div>
                  </div>
                  <div className="field"><label htmlFor="f-role">角色名（显示在名字旁边）</label><input className="input" id="f-role" value={form.role} onChange={(e) => set('role', e.target.value)} /></div>
                  <div className="field">
                    <label htmlFor="f-temp">温度：越高越发散</label>
                    <div className="range-row" style={noTemp ? { opacity: 0.45 } : undefined}>
                      <input type="range" id="f-temp" disabled={noTemp} min={0} max={1} step={0.1} value={form.temperature} style={{ ['--p' as string]: `${form.temperature * 100}%` }} onChange={(e) => set('temperature', Number(e.target.value))} />
                      <span className="range-val num">{form.temperature.toFixed(1)}</span>
                    </div>
                    {noTemp && <span className="faint" style={{ fontSize: 12 }}>这个模型不支持调温度，设置不会生效</span>}
                  </div>
                  <div className="field">
                    <label htmlFor="f-budget">每月预算上限（元，留空表示不限）</label>
                    <input className="input num" id="f-budget" inputMode="decimal" value={form.monthly_budget_cny ?? ''}
                      onChange={(e) => set('monthly_budget_cny', e.target.value === '' ? null : Number(e.target.value.replace(/[^\d.]/g, '')))} />
                  </div>
                  <div className="field">
                    <label htmlFor="f-chars">每次发言字数上限</label>
                    <select className="select" id="f-chars" value={form.max_chars ?? 0} onChange={(e) => set('max_chars', Number(e.target.value) || null)}>
                      <option value={300}>300 字</option><option value={600}>600 字</option><option value={1200}>1200 字</option><option value={0}>不限</option>
                    </select>
                  </div>
                </div>
                <div style={{ marginTop: 22 }}>
                  <div className="setting-line">
                    <div><b>允许主动 @ 其他模型</b><span>打开后它可以直接向别的模型提问（M3 起生效）</span></div>
                    <button className="toggle" role="switch" aria-checked={form.can_mention} aria-label="允许主动 @ 其他模型" onClick={() => set('can_mention', !form.can_mention)} />
                  </div>
                  <div className="setting-line">
                    <div>
                      <b>允许运行代码</b>
                      <span>
                        {runBlock && !form.can_run_code ? runBlock
                          : '发言时可以在隔离的沙箱里运行 Python、Node.js 和网页，看到结果再继续写。不能联网，不额外收费，但多轮调用会增加模型费用'}
                        {sandbox?.enabled && !sandbox.available && <><br /><span className="error-text">运行环境暂不可用：{sandbox.reason}</span></>}
                      </span>
                    </div>
                    <button className="toggle" role="switch" aria-checked={form.can_run_code} aria-label="允许运行代码"
                      disabled={!!runBlock && !form.can_run_code} onClick={() => set('can_run_code', !form.can_run_code)} />
                  </div>
                </div>
              </fieldset>
              {user?.is_admin ? (
                <div className="editor-foot">
                  <button className="btn btn-danger" onClick={remove} style={{ marginRight: 'auto' }}><Icon name="trash" size={14} />删除</button>
                  <button className="btn btn-ink" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存设置'}</button>
                </div>
              ) : <p className="faint" style={{ fontSize: 12.5, marginTop: 16 }}>只有管理员可以修改成员设置。</p>}
            </div>
          ) : <div className="editor faint">还没有模型成员。</div>}
        </div>
      </div>
    </section>
  )
}
