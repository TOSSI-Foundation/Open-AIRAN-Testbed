import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AgentChat, AgentSettings, Transcript, call, tok, type Item } from '../components/AgentDock'
import { Icon } from '../components/Icon'
import { Card, PageHeader } from '../components/ui'
import { font, palette } from '../styles/theme'

interface AgentInfo {
  key: string; label: string; blurb: string; status: string; pending: number; conversations: number
  tools: { name: string; description: string; approval: boolean }[]
}
interface Activity { t: number; user: string; agent: string; tool: string; summary: string; outcome: string }
interface Overview {
  agents: AgentInfo[]
  llm: { provider: string; model: string; key_set: boolean }
  activity: Activity[]
  stats: { running_stacks: number; approvals_waiting: number; actions_today: number; changes_today: number }
  tokens_today?: { in: number; out: number; cached: number; calls: number; by_agent: Record<string, { in: number; out: number; calls: number }>
                   by_model: Record<string, { in: number; out: number; calls: number }> }
}
interface Conv { id: string; title: string; created: number; updated: number; messages: number; tools: number; current: boolean }

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', WELL = '#F3F7F8'
const LOOK: Record<string, { color: string; glyph: keyof typeof Icon }> = {
  deploy: { color: palette.teal, glyph: 'deploy' },
  ml: { color: palette.rose, glyph: 'studio' },
  general: { color: palette.navy, glyph: 'agents' },
}
const SUGGEST: Record<string, string[]> = {
  deploy: ['Which stacks are running?', 'Can ai-ran-bsr run on this server?', 'Why did my last deploy fail?',
           'Run OAI L1 on server 5 and xFAPI + OCUDU L2 here'],
  ml: ['Is ai-ran-bsr collecting good training data?', 'Train the BSR model and switch to shadow mode',
       'How does the BSR predictor use the model?', 'Why does the CSI trainer fail?'],
  general: ['What does each stack do?', 'Explain the 7.2 fronthaul setup here', 'How do I add a new stack?'],
}
const STATUS: Record<string, { label: string; color: string }> = {
  idle: { label: 'ready', color: '#0F8A5F' }, running: { label: 'working', color: palette.steel },
  stopping: { label: 'stopping', color: palette.greyTeal },
  approval: { label: 'needs approval', color: palette.rose }, error: { label: 'error', color: '#B3272C' },
}
const OUTCOME: Record<string, string> = { ran: palette.steel, approved: '#0F8A5F', declined: palette.greyTeal, error: '#B3272C' }

export function AgentIcon({ agent, size = 40 }: { agent: string; size?: number }) {
  const { color, glyph } = LOOK[agent] ?? LOOK.general
  const G = Icon[glyph]
  return (
    <span style={{ width: size, height: size, flex: `0 0 ${size}px`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <G size={size * 0.62} stroke={color} />
    </span>
  )
}

function Art({ agent }: { agent: string }) {
  const src = `/agents/${['deploy', 'ml', 'general'].includes(agent) ? agent : 'general'}.png`
  return <img src={src} alt="" aria-hidden style={{ width: 260, height: 200, objectFit: 'contain', userSelect: 'none', pointerEvents: 'none' }} />
}

const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 60 ? `${s | 0}s` : s < 3600 ? `${(s / 60) | 0}m` : s < 86400 ? `${(s / 3600) | 0}h` : `${(s / 86400) | 0}d`
}

function Stat({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub: string; tone: string }) {
  return (
    <Card pad={14} style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <span style={{ width: 38, height: 38, flex: '0 0 38px', borderRadius: 10, background: 'rgba(50,121,133,.10)', color: palette.teal,
                     display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{icon}</span>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase', color: palette.greyTeal }}>{label}</div>
        <div style={{ fontSize: 19, fontWeight: 800, color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
        <div style={{ fontSize: 11.5, fontWeight: 600, color: tone }}>{sub}</div>
      </div>
    </Card>
  )
}

const tab = (on: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  color: on ? palette.navy : MUT, background: on ? 'rgba(50,121,133,.10)' : 'transparent',
  border: `1px solid ${on ? 'rgba(50,121,133,.40)' : 'transparent'}`,
})
const small = (primary = false): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  color: primary ? '#fff' : INK, background: primary ? palette.teal : '#fff', border: `1px solid ${primary ? palette.teal : LINE}`,
})

function History({ agent, onResumed }: { agent: string; onResumed: () => void }) {
  const [list, setList] = useState<Conv[] | null>(null)
  const [open, setOpen] = useState<{ id: string; title: string; items: Item[] } | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => call<{ conversations: Conv[] }>(`/${agent}/history`).then((r) => setList(r.conversations)).catch((e) => setErr(e.message)), [agent])
  useEffect(() => { setOpen(null); load() }, [load])
  const resume = async (id: string) => { try { await call(`/${agent}/history/${id}/resume`, { method: 'POST' }); onResumed() } catch (e) { setErr((e as Error).message) } }
  const remove = async (id: string) => { try { await call(`/${agent}/history/${id}`, { method: 'DELETE' }); setOpen(null); load() } catch (e) { setErr((e as Error).message) } }

  if (open) return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', borderBottom: `1px solid ${LINE}` }}>
        <button onClick={() => setOpen(null)} style={small()}>← History</button>
        <span style={{ fontWeight: 700, flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{open.title || 'Untitled'}</span>
        <button onClick={() => resume(open.id)} style={small(true)}>Continue</button>
        <button onClick={() => remove(open.id)} style={{ ...small(), color: '#B3272C' }}>Delete</button>
      </div>
      {err && <div style={{ color: '#B3272C', fontSize: 12.5, padding: '6px 14px' }}>{err}</div>}
      <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 10, fontSize: 13.5 }}>
        <Transcript items={open.items} />
      </div>
    </div>
  )
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      {err && <div style={{ color: '#B3272C', fontSize: 12.5, marginBottom: 8 }}>{err}</div>}
      {list && !list.length && <div style={{ color: MUT, textAlign: 'center', marginTop: 60 }}>No conversations</div>}
      {list?.map((c) => (
        <button key={c.id} onClick={() => call<{ id: string; title: string; items: Item[] }>(`/${agent}/history/${c.id}`).then(setOpen).catch((e) => setErr(e.message))}
          style={{ display: 'flex', width: '100%', alignItems: 'center', gap: 12, textAlign: 'left', padding: '11px 12px', marginBottom: 6,
                   borderRadius: 10, border: `1px solid ${LINE}`, background: '#fff', cursor: 'pointer', fontFamily: 'inherit' }}>
          <AgentIcon agent={agent} size={28} />
          <span style={{ flex: 1, minWidth: 0 }}>
            <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, color: INK, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title || 'Untitled'}</span>
            <span style={{ fontSize: 12, color: MUT }}>{new Date(c.updated * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · {c.messages} message{c.messages === 1 ? '' : 's'} · {c.tools} tool call{c.tools === 1 ? '' : 's'}</span>
          </span>
          {c.current && <span style={{ fontSize: 11, fontWeight: 800, color: palette.teal, background: 'rgba(50,121,133,.10)', padding: '3px 9px', borderRadius: 999 }}>open</span>}
        </button>
      ))}
    </div>
  )
}

function Tools({ info }: { info: AgentInfo }) {
  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 10, alignContent: 'start' }}>
      {info.tools.map((t) => (
        <div key={t.name} style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: '10px 12px', background: '#fff',
                                   borderLeft: `3px solid ${t.approval ? palette.rose : palette.teal}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontFamily: font.mono, fontSize: 12.5, fontWeight: 700 }}>{t.name}</span>
            <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, padding: '2px 8px', borderRadius: 999,
                           color: t.approval ? palette.rose : palette.teal, background: t.approval ? 'rgba(216,105,147,.10)' : 'rgba(50,121,133,.10)' }}>
              {t.approval ? 'asks first' : 'read'}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

export function ScreenAgents() {
  const [params, setParams] = useSearchParams()
  const [ov, setOv] = useState<Overview | null>(null)
  const [view, setView] = useState<'chat' | 'history' | 'tools' | 'settings'>('chat')
  const [chatKey, setChatKey] = useState(0)
  const agent = ['deploy', 'ml', 'general'].includes(params.get('agent') || '') ? params.get('agent')! : 'deploy'
  const info = ov?.agents.find((a) => a.key === agent)

  const refresh = useCallback(() => call<Overview>('/overview').then(setOv).catch(() => {}), [])
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t) }, [refresh])

  const s = ov?.stats
  const tk = ov?.tokens_today
  const llmOk = !!ov && (ov.llm.key_set || ov.llm.provider === 'openai') && !!ov.llm.model
  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader title="Agents" />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 14 }}>
        <Stat icon={<Icon.studio size={20} />} label="LLM" value={ov ? (ov.llm.model || '—') : '…'}
          sub={llmOk ? (ov!.llm.provider === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible') : 'not set up'} tone={llmOk ? '#0F8A5F' : palette.rose} />
        <Stat icon={<Icon.runs size={20} />} label="Tokens today" value={tk ? tok(tk.in + tk.out) : '…'}
          sub={tk ? `${tok(tk.in)} in · ${tok(tk.out)} out · ${tk.calls} calls${tk.cached ? ` · ${tok(tk.cached)} cached` : ''}` : ''} tone={palette.teal} />
        <Stat icon={<Icon.check size={20} />} label="Approvals" value={s?.approvals_waiting ?? '…'}
          sub={s?.approvals_waiting ? 'PENDING' : 'none'} tone={s?.approvals_waiting ? palette.rose : '#0F8A5F'} />
        <Stat icon={<Icon.runs size={20} />} label="Actions today" value={s?.actions_today ?? '…'} sub={`${s?.changes_today ?? 0} approved`} tone={palette.teal} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '250px minmax(0, 1fr) 290px', gap: 18, alignItems: 'start' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {(ov?.agents ?? []).map((a) => {
            const on = a.key === agent && view !== 'settings'
            const st = STATUS[a.status] ?? STATUS.idle
            return (
              <button key={a.key} onClick={() => { setParams({ agent: a.key }); if (view === 'settings') setView('chat') }}
                style={{ textAlign: 'left', padding: 14, borderRadius: 14, cursor: 'pointer', fontFamily: 'inherit', background: '#fff',
                         border: `1px solid ${on ? 'rgba(50,121,133,.55)' : LINE}`, boxShadow: on ? '0 10px 24px -16px rgba(39,85,120,.6)' : 'none' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <AgentIcon agent={a.key} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 15, color: INK }}>{a.label}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11.5, fontWeight: 700, color: st.color }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', background: st.color,
                                     animation: a.status === 'running' ? 'sk-pulse 1.2s infinite' : undefined }} />
                      {a.pending ? `${a.pending} to approve` : st.label}
                    </div>
                  </div>
                </div>
                <div style={{ fontSize: 11.5, color: palette.greyTeal, marginTop: 8 }}>{a.conversations} chats · {a.tools.length} tools{tk?.by_agent[a.key] ? ` · ${tok(tk.by_agent[a.key].in + tk.by_agent[a.key].out)} tokens` : ''}</div>
              </button>
            )
          })}
          <button onClick={() => setView('settings')}
            style={{ ...small(), padding: '11px 14px', textAlign: 'left', borderRadius: 14, display: 'flex', alignItems: 'center', gap: 8,
                     borderColor: view === 'settings' ? 'rgba(50,121,133,.55)' : LINE, color: llmOk ? INK : palette.rose }}>
            <Icon.gear size={17} /> LLM settings{llmOk ? '' : ' · set up'}
          </button>
        </div>

        <Card pad={0} style={{ height: 'calc(100vh - 300px)', minHeight: 460, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          {view === 'settings' ? <AgentSettings onDone={() => { setView('chat'); refresh() }} /> : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', borderBottom: `1px solid ${LINE}` }}>
                <AgentIcon agent={agent} size={30} />
                <span style={{ fontWeight: 800, fontSize: 15 }}>{info?.label ?? ''} agent</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
                  {(['chat', 'history', 'tools'] as const).map((v) => (
                    <button key={v} onClick={() => setView(v)} style={tab(view === v)}>{v[0].toUpperCase() + v.slice(1)}</button>
                  ))}
                </span>
              </div>
              {view === 'chat' && (
                <AgentChat key={`${agent}-${chatKey}`} agent={agent} suggestions={SUGGEST[agent]} onStatus={refresh}
                  empty={<Art agent={agent} />} />
              )}
              {view === 'history' && <History agent={agent} onResumed={() => { setChatKey((k) => k + 1); setView('chat'); refresh() }} />}
              {view === 'tools' && info && <Tools info={info} />}
            </>
          )}
        </Card>

        <Card pad={14} style={{ height: 'calc(100vh - 300px)', minHeight: 460, overflow: 'auto' }}>
          <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 10 }}>Activity</div>
          {ov && !ov.activity.length && <div style={{ color: MUT, fontSize: 12.5 }}>None</div>}
          {ov?.activity.map((x, i) => (
            <div key={i} style={{ display: 'flex', gap: 9, padding: '8px 0', borderTop: i ? `1px solid ${LINE}` : 'none' }}>
              <AgentIcon agent={x.agent} size={22} />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontFamily: font.mono, fontSize: 12, fontWeight: 700 }}>{x.tool}</span>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: OUTCOME[x.outcome] ?? MUT }} title={x.outcome} />
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: palette.greyTeal }}>{ago(x.t)}</span>
                </div>
                <div style={{ fontSize: 11.5, color: MUT, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={x.summary}>
                  {x.outcome !== 'ran' && <b style={{ color: OUTCOME[x.outcome] }}>{x.outcome} · </b>}{x.summary || '—'}
                </div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  )
}
