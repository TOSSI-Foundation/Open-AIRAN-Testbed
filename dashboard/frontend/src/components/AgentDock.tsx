import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { font, palette } from '../styles/theme'
import { ResizeGrip, useFloating } from './Floating'

export interface Call { id: string; name: string; input: Record<string, unknown>; diff?: string }
export interface Item { role: 'user' | 'assistant' | 'tool'; text?: string; calls?: Call[]; name?: string; result?: string; error?: boolean }
interface Usage { calls: number; in: number; out: number; cached: number; last_in: number; ms: number }
interface State { agent: string; status: 'idle' | 'running' | 'stopping' | 'approval' | 'error'; error: string; items: Item[]; pending: Call[]
  auto: boolean; usage: Usage; model: string }
export const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
interface LlmCfg { provider: 'anthropic' | 'openai'; base_url: string; model: string; key_set: boolean; key_hint: string }

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', WELL = '#F3F7F8'
const AGENTS = [{ key: 'deploy', label: 'Deploy' }, { key: 'ml', label: 'ML' }, { key: 'general', label: 'General' }]

export async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/agents${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...authHeader() } })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`)
  return r.json()
}

function Md({ text }: { text: string }) {
  return (
    <>
      {text.split(/```[\w-]*\n?/).map((part, i) =>
        i % 2 ? (
          <pre key={i} style={{ margin: '6px 0', padding: '8px 10px', borderRadius: 8, background: '#13304A', color: '#DCE6EF',
                                fontFamily: font.mono, fontSize: 11.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{part.replace(/\n$/, '')}</pre>
        ) : (
          <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
            {part.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/).map((s, j) =>
              s.startsWith('`') ? <code key={j} style={{ fontFamily: font.mono, fontSize: '0.92em', background: WELL, padding: '0 4px', borderRadius: 4 }}>{s.slice(1, -1)}</code>
                : s.startsWith('**') ? <b key={j}>{s.slice(2, -2)}</b> : s)}
          </span>
        ))}
    </>
  )
}

function describe(c: Call): string {
  const i = c.input as Record<string, string>
  if (c.name === 'run_action') return `make ${i.action} STACK=${i.stack}`
  if (c.name === 'save_settings') return `${i.stack}: ${Object.entries(i.changes || {}).map(([k, v]) => `${k}=${v}`).join(' ')}`
  if (c.name === 'write_file') return `write ${i.path}`
  return c.name
}

function ToolLine({ it }: { it: Item }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ fontSize: 11.5, color: it.error ? '#B3272C' : MUT }}>
      <button onClick={() => setOpen(!open)} style={{ all: 'unset', cursor: 'pointer', fontFamily: font.mono }}>
        {open ? '▾' : '▸'} {it.name}{it.error ? ' · error' : ''}
      </button>
      {open && <pre style={{ margin: '4px 0', padding: 8, borderRadius: 8, background: WELL, fontFamily: font.mono, fontSize: 11,
                             whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 220, overflow: 'auto', color: INK }}>{it.result}</pre>}
    </div>
  )
}

export function AgentSettings({ onDone }: { onDone?: () => void }) {
  const [cfg, setCfg] = useState<LlmCfg | null>(null)
  const [key, setKey] = useState('')
  const [models, setModels] = useState<string[] | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { call<LlmCfg>('/config').then(setCfg).catch((e) => setMsg({ ok: false, text: e.message })) }, [])
  const listModels = useCallback((c: LlmCfg, k: string) => {
    setModels(null)
    call<{ models: string[]; error?: string }>('/config/models', { method: 'POST', body: JSON.stringify({ provider: c.provider, base_url: c.base_url, api_key: k }) })
      .then((r) => setModels(r.models)).catch(() => setModels([]))
  }, [])
  useEffect(() => { if (cfg) listModels(cfg, key) }, [cfg?.provider, cfg?.base_url]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!cfg) return <div style={{ padding: 16, color: MUT }}>{msg?.text || 'Loading…'}</div>
  const save = async () => {
    try {
      setCfg(await call<LlmCfg>('/config', { method: 'PUT', body: JSON.stringify({ ...cfg, api_key: key }) }))
      setKey(''); setMsg({ ok: true, text: 'Saved' })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
  }
  const test = async () => {
    setMsg({ ok: true, text: 'Testing…' })
    type T = { ok: boolean; reply?: string; error?: string }
    const r = await call<T>('/config/test', { method: 'POST' }).catch((e): T => ({ ok: false, error: e.message }))
    setMsg(r.ok ? { ok: true, text: 'Works' } : { ok: false, text: r.error || 'failed' })
  }
  const field = (label: string, el: React.ReactNode) => (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 700, color: INK }}>{label}{el}</label>
  )
  const inp: React.CSSProperties = { padding: '8px 10px', borderRadius: 8, border: `1px solid ${LINE}`, background: WELL, fontFamily: font.mono, fontSize: 12.5, outline: 'none' }
  const opts = models && [...new Set([...(cfg.model ? [cfg.model] : []), ...models])]
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto', maxWidth: 560 }}>
      {field('Provider', (
        <select value={cfg.provider} style={inp}
          onChange={(e) => setCfg({ ...cfg, provider: e.target.value as LlmCfg['provider'],
                                    ...(e.target.value === 'anthropic' ? { base_url: '', model: 'claude-opus-5-5' } : { base_url: 'https://api.openai.com/v1', model: '' }) })}>
          <option value="anthropic">Anthropic</option>
          <option value="openai">OpenAI-compatible</option>
        </select>))}
      {field('Base URL', <input style={inp} value={cfg.base_url} onChange={(e) => setCfg({ ...cfg, base_url: e.target.value })}
        placeholder={cfg.provider === 'anthropic' ? 'default' : 'http://host:11434/v1'} />)}
      {field('API key', <input style={inp} type="password" value={key} onChange={(e) => setKey(e.target.value)}
        onBlur={() => key && listModels(cfg, key)}
        placeholder={cfg.key_set ? `saved ${cfg.key_hint}` : cfg.provider === 'openai' ? 'optional' : ''} />)}
      {field('Model', (
        <span style={{ display: 'flex', gap: 6 }}>
          {opts && opts.length ? (
            <select style={{ ...inp, flex: 1 }} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })}>
              {!cfg.model && <option value="">choose a model</option>}
              {opts.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          ) : (
            <input style={{ ...inp, flex: 1 }} value={cfg.model} onChange={(e) => setCfg({ ...cfg, model: e.target.value })}
              placeholder={models === null ? 'loading models…' : 'model'} />
          )}
          <button onClick={() => listModels(cfg, key)} title="Reload models" style={btn(false)}>↻</button>
        </span>))}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={save} style={btn(true)}>Save</button>
        <button onClick={test} style={btn(false)}>Test</button>
        {onDone && <button onClick={onDone} style={{ ...btn(false), marginLeft: 'auto' }}>Back</button>}
      </div>
      {msg && <div style={{ fontSize: 12.5, color: msg.ok ? '#0F8A5F' : '#B3272C', wordBreak: 'break-word' }}>{msg.text}</div>}
    </div>
  )
}

const btn = (primary: boolean): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  color: primary ? '#fff' : INK, background: primary ? palette.teal : '#fff', border: `1px solid ${primary ? palette.teal : LINE}`,
})

export const AGENT_LIST = AGENTS

export function Transcript({ items }: { items: Item[] }) {
  return (
    <>
      {items.map((it, i) =>
        it.role === 'user' ? (
          <div key={i} style={{ alignSelf: 'flex-end', maxWidth: '85%', background: palette.teal, color: '#fff', padding: '8px 12px',
                                borderRadius: '12px 12px 4px 12px', whiteSpace: 'pre-wrap' }}>{it.text?.replace(/\n\n\(operator is on the dashboard page: .*\)$/, '')}</div>
        ) : it.role === 'tool' ? <ToolLine key={i} it={it} /> : it.text ? (
          <div key={i} style={{ lineHeight: 1.5 }}><Md text={it.text} /></div>
        ) : null)}
    </>
  )
}

export function AgentChat({ agent, suggestions = [], empty, onStatus, draft }: {
  agent: string; suggestions?: string[]; empty?: React.ReactNode; onStatus?: (s: string) => void; draft?: { text: string; n: number }
}) {
  const loc = useLocation()
  const [st, setSt] = useState<State | null>(null)
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!draft?.n) return
    setText(draft.text)
    setTimeout(() => { const b = box.current; if (b) { b.focus(); b.setSelectionRange(b.value.length, b.value.length); b.scrollTop = b.scrollHeight } }, 0)
  }, [draft?.n]) // eslint-disable-line react-hooks/exhaustive-deps
  const [err, setErr] = useState('')
  const end = useRef<HTMLDivElement>(null)

  const load = useCallback(() => call<State>(`/${agent}`).then(setSt).catch((e) => setErr(e.message)), [agent])
  useEffect(() => { setSt(null); setErr(''); load() }, [load])
  useEffect(() => {
    if (st?.status !== 'running' && st?.status !== 'stopping') return
    const t = setInterval(load, 1000)
    return () => clearInterval(t)
  }, [st?.status, load])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [st?.items.length, st?.status])
  useEffect(() => { if (st) onStatus?.(st.status) }, [st?.status]) // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (t = text) => {
    if (!t.trim()) return
    setErr('')
    try { setSt(await call<State>(`/${agent}/message`, { method: 'POST', body: JSON.stringify({ text: t, context: loc.pathname + loc.search }) })); setText('') }
    catch (e) { setErr((e as Error).message) }
  }
  const decide = async (approve: Record<string, boolean>) => {
    try { setSt(await call<State>(`/${agent}/decide`, { method: 'POST', body: JSON.stringify({ approve }) })) }
    catch (e) { setErr((e as Error).message) }
  }
  const reset = async () => { try { setSt(await call<State>(`/${agent}`, { method: 'DELETE' })) } catch (e) { setErr((e as Error).message) } }
  const running = st?.status === 'running' || st?.status === 'stopping'
  const busy = running || st?.status === 'approval'
  const stop = async () => { try { setSt(await call<State>(`/${agent}/stop`, { method: 'POST' })) } catch (e) { setErr((e as Error).message) } }
  const setAuto = async (on: boolean) => {
    if (on && !confirm('Auto-approve all changes?')) return
    try { setSt(await call<State>(`/${agent}/auto`, { method: 'POST', body: JSON.stringify({ on }) })) } catch (e) { setErr((e as Error).message) }
  }
  const [models, setModels] = useState<string[]>([])
  useEffect(() => { call<{ models: string[] }>('/config/models', { method: 'POST', body: '{}' }).then((r) => setModels(r.models ?? [])).catch(() => {}) }, [])
  const setModel = async (model: string) => {
    try { await call('/config', { method: 'PUT', body: JSON.stringify({ model }) }); load() } catch (e) { setErr((e as Error).message) }
  }
  const u = st?.usage

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {st && !st.items.length && (
          <div style={{ margin: 'auto 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
            {empty}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'center', maxWidth: 560 }}>
              {suggestions.map((q) => (
                <button key={q} onClick={() => send(q)}
                  style={{ ...btn(false), fontWeight: 600, borderRadius: 999, padding: '7px 13px', background: WELL }}>{q}</button>
              ))}
            </div>
          </div>
        )}
        {st && <Transcript items={st.items} />}
        {running && <div style={{ color: MUT, fontSize: 12.5 }}><span style={{ animation: 'sk-pulse 1.2s infinite' }}>●</span> {st?.status === 'stopping' ? 'stopping…' : 'working…'}</div>}
        {st?.status === 'approval' && (
          <div style={{ border: '1px solid rgba(216,105,147,.45)', background: 'rgba(216,105,147,.06)', borderRadius: 12, padding: 12,
                        display: 'flex', flexDirection: 'column', gap: 8 }}>
            {st.pending.map((c) => (
              <div key={c.id}>
                <div style={{ fontFamily: font.mono, fontSize: 12.5, fontWeight: 700 }}>{describe(c)}</div>
                {c.diff && <pre style={{ margin: '6px 0 0', padding: 8, borderRadius: 8, background: '#13304A', color: '#DCE6EF', fontFamily: font.mono,
                                         fontSize: 11, maxHeight: 260, overflow: 'auto', whiteSpace: 'pre' }}>{c.diff}</pre>}
              </div>
            ))}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={() => decide(Object.fromEntries(st.pending.map((c) => [c.id, true])))} style={btn(true)}>Approve</button>
              <button onClick={() => decide({})} style={{ ...btn(false), color: '#B3272C' }}>Deny</button>
            </div>
          </div>
        )}
        {st?.status === 'error' && <div style={{ color: '#B3272C', fontSize: 12.5 }}>{st.error}</div>}
        {err && <div style={{ color: '#B3272C', fontSize: 12.5 }}>{err}</div>}
        <div ref={end} />
      </div>
      <div style={{ borderTop: `1px solid ${LINE}`, padding: '7px 10px 0', display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, color: MUT, flexWrap: 'wrap' }}>
        <select value={st?.model ?? ''} onChange={(e) => setModel(e.target.value)} title="Model"
          style={{ fontFamily: font.mono, fontSize: 11.5, padding: '3px 6px', borderRadius: 7, border: `1px solid ${LINE}`, background: '#fff', maxWidth: 210 }}>
          {[...new Set([st?.model ?? '', ...models])].filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                       fontWeight: 700, color: st?.auto ? '#B07908' : MUT }}>
          <input type="checkbox" checked={!!st?.auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-approve
        </label>
        {!!u?.calls && (
          <span style={{ marginLeft: 'auto', fontFamily: font.mono, fontSize: 11 }}
            title={`${u.calls} calls · ${tok(u.cached)} cached · ${(u.ms / 1000).toFixed(0)} s`}>
            {tok(u.in)} in · {tok(u.out)} out · ctx {tok(u.last_in)}
          </span>
        )}
      </div>
      <div style={{ padding: 10, display: 'flex', gap: 8 }}>
        <textarea ref={box} value={text} onChange={(e) => setText(e.target.value)} disabled={busy}
          rows={Math.min(10, Math.max(2, text.split('\n').length))}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={busy ? '' : `Ask the ${AGENTS.find((a) => a.key === agent)?.label} agent`}
          style={{ flex: 1, resize: 'none', padding: '8px 10px', borderRadius: 10, border: `1px solid ${LINE}`, background: WELL,
                   fontFamily: 'inherit', fontSize: 13.5, outline: 'none' }} />
        {running ? (
          <button onClick={stop} disabled={st?.status === 'stopping'}
            style={{ ...btn(false), color: '#fff', background: '#B3272C', border: '1px solid #B3272C', opacity: st?.status === 'stopping' ? 0.6 : 1,
                     display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#fff' }} />Stop
          </button>
        ) : (
          <>
            {!!st?.items.length && st.status !== 'approval' && <button onClick={reset} style={btn(false)}>New chat</button>}
            <button onClick={() => send()} disabled={busy || !text.trim()} style={{ ...btn(true), opacity: busy || !text.trim() ? 0.5 : 1 }}>Send</button>
          </>
        )}
      </div>
    </div>
  )
}

export function AgentDock() {
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [agent, setAgent] = useState('deploy')
  const [settings, setSettings] = useState(false)
  const fl = useFloating('dock.agents', { right: 24, bottom: 24 }, { w: 440, h: 660 })
  useEffect(() => {
    if (open) call<{ llm: LlmCfg }>('').then((r) => { if (!r.llm.key_set && r.llm.provider === 'anthropic') setSettings(true) }).catch(() => {})
  }, [open])

  if (loc.pathname === '/login' || loc.pathname === '/agents' || loc.pathname === '/studio') return null
  const { w: W, h: H } = fl.size
  if (!open) return (
    <button onPointerDown={(e) => fl.start(e, 130, 52)} onClick={() => !fl.dragged() && setOpen(true)}
      style={{ position: 'fixed', ...fl.fit(fl.at, 130, 52), zIndex: 900, height: 52, padding: '0 20px', borderRadius: 26, cursor: 'pointer', touchAction: 'none',
               background: palette.navy, color: '#fff', border: 'none', fontFamily: 'inherit', fontWeight: 800, fontSize: 14,
               boxShadow: '0 14px 30px -12px rgba(39,85,120,.7)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 18 }}>✦</span> Agents
    </button>
  )
  return (
    <div style={{ position: 'fixed', ...fl.fit(fl.at, W, H), zIndex: 900, width: W, height: H,
                  background: '#fff', borderRadius: 16, border: `1px solid ${LINE}`, boxShadow: '0 30px 70px -28px rgba(39,85,120,.6)',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden', fontSize: 13.5, color: INK }}>
      <ResizeGrip onPointerDown={fl.startResize} />
      <div onPointerDown={(e) => fl.start(e, W, H)}
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '10px 12px', borderBottom: `1px solid ${LINE}`, background: '#F7FAFB', cursor: 'move', touchAction: 'none' }}>
        {AGENTS.map((a) => (
          <button key={a.key} onClick={() => { setAgent(a.key); setSettings(false) }}
            style={{ ...btn(false), border: 'none', background: agent === a.key && !settings ? 'rgba(50,121,133,.12)' : 'transparent',
                     color: agent === a.key && !settings ? palette.navy : MUT }}>{a.label}</button>
        ))}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
          <button onClick={() => setSettings(!settings)} title="LLM settings" style={{ ...btn(false), border: 'none', background: settings ? 'rgba(50,121,133,.12)' : 'transparent' }}>⚙</button>
          <button onClick={() => setOpen(false)} title="Close" style={{ ...btn(false), border: 'none', background: 'transparent' }}>✕</button>
        </span>
      </div>
      {settings ? <AgentSettings onDone={() => setSettings(false)} /> : <AgentChat key={agent} agent={agent} />}
    </div>
  )
}
