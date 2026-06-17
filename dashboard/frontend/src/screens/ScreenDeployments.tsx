import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import { authHeader } from '../lib/auth'
import { Card, PageHeader, StatusPill } from '../components/ui'
import { font } from '../styles/theme'
import { hostsApi, target, type Host } from './ScreenServers'
import { canChange, useAuth } from '../lib/useAuth'

interface Stack {
  name: string
  group: string
  desc: string
  doc: string
  components?: string[]
  start_order?: string[]
  needs?: string[]
  ocudu_branch?: string
  oai_branch?: string
  running: boolean
  running_on?: string[]
  error?: string
  hosts?: Record<string, string>
  trainable?: boolean
  build?: { state: 'built' | 'building' | 'failed' | 'none'; at: number | null }
}
interface Job {
  id: string
  stack: string
  action: string
  env: Record<string, string>
  user: string
  cmd: string
  state: 'running' | 'ok' | 'failed' | 'cancelled' | 'orphaned' | 'lost'
  rc: number | null
  started: number
  ended: number | null
}
interface Comp { name: string; state: 'up' | 'down'; pid: string | null }
interface ResultRun { run: string; files: { name: string; bytes: number }[] }

const C = {
  ink: '#0E1820', mut: '#5B6E77', faint: '#6D8E99', line: '#E2E9EA', card: '#FFFFFF',
  well: '#F3F7F8', teal: '#327985', navy: '#275578', steel: '#6093BA', rose: '#D86993',
  ok: '#0F8A5F', warn: '#B07908', bad: '#B3272C',
}
const SEL_BG = 'rgba(50,121,133,.10)'
const SEL_BORDER = 'rgba(50,121,133,.40)'
const TONE: Record<string, { fg: string; bg: string }> = {
  running: { fg: C.teal, bg: 'rgba(50,121,133,.12)' },
  ok: { fg: C.ok, bg: 'rgba(15,138,95,.12)' },
  failed: { fg: C.bad, bg: 'rgba(179,39,44,.10)' },
  cancelled: { fg: C.warn, bg: 'rgba(176,121,8,.12)' },
  orphaned: { fg: C.bad, bg: 'rgba(179,39,44,.10)' },
  lost: { fg: C.faint, bg: 'rgba(109,142,153,.14)' },
  up: { fg: C.ok, bg: 'rgba(15,138,95,.12)' },
  down: { fg: C.faint, bg: 'rgba(109,142,153,.14)' },
}
const ACTIONS: { key: string; label: string; hint: string; primary?: boolean; danger?: boolean }[] = [
  { key: 'all', label: 'Run all', hint: 'check → build → deploy', primary: true },
  { key: 'check', label: 'Check', hint: 'requirements' },
  { key: 'build', label: 'Build', hint: 'compile' },
  { key: 'deploy', label: 'Deploy', hint: 'start' },
  { key: 'train', label: 'Train', hint: 'train model' },
  { key: 'stop', label: 'Stop', hint: 'stop', danger: true },
]
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/deploy${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(init?.headers || {}) },
  })
  if (!r.ok) {
    let msg = `${r.status}`
    try { msg = (await r.json()).detail || msg } catch {  }
    throw new Error(msg)
  }
  return r.json()
}

const ago = (t: number) => {
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`
}
const dur = (j: Job) => {
  const s = Math.round((j.ended ?? Date.now() / 1000) - j.started)
  return s < 60 ? `${s}s` : `${(s / 60) | 0}m ${s % 60}s`
}

function Chip({ children, color = C.mut }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 10px', borderRadius: 999,
                   fontSize: 12, fontWeight: 600, color, background: C.well,
                   border: `1px solid ${C.line}` }}>{children}</span>
  )
}

function Btn({ children, onClick, disabled, primary, danger, title, tone }: {
  children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean; danger?: boolean; title?: string
  tone?: 'ok' | 'bad'
}) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      style={{ padding: '9px 16px', borderRadius: 10, fontSize: 13.5, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer',
               opacity: disabled ? 0.45 : 1, fontFamily: 'inherit',
               color: primary || tone === 'ok' ? '#FFFFFF' : danger || tone === 'bad' ? C.bad : C.ink,
               background: primary ? C.teal : tone === 'ok' ? C.ok : tone === 'bad' ? 'rgba(179,39,44,.06)' : C.card,
               border: `1px solid ${primary ? C.teal : tone === 'ok' ? C.ok : danger || tone === 'bad' ? 'rgba(179,39,44,.45)' : C.line}`,
               boxShadow: primary ? '0 8px 20px -12px rgba(50,121,133,.8)' : 'none' }}>
      {children}
    </button>
  )
}

const LINE_STYLE: [RegExp, React.CSSProperties][] = [
  [/^\s*ok\s/, { color: '#4CD787', fontWeight: 600 }],
  [/^\s*no\s/, { color: '#FFD9DB', background: 'rgba(225,80,88,.35)', fontWeight: 700 }],
  [/^\s+(fix|installed by):/, { color: '#FFB3B8' }],
  [/^XX\s|\[E\]|\bERROR\b|\bfailed\b|died during/, { color: '#FFD9DB', background: 'rgba(225,80,88,.35)', fontWeight: 700 }],
  [/^!!\s/, { color: '#FFD58A' }],
  [/^==\s/, { color: '#9CC8EE', fontWeight: 700 }],
  [/^\$\s/, { color: '#8FA9BE' }],
]
const lineStyle = (l: string) => LINE_STYLE.find(([re]) => re.test(l))?.[1]

function Console({ text, height = 380 }: { text: string; height?: number }) {
  const ref = useRef<HTMLPreElement>(null)
  const follow = useRef(true)
  const [atEnd, setAtEnd] = useState(true)
  const toEnd = () => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    follow.current = true; setAtEnd(true)
  }
  useLayoutEffect(() => {
    if (!text) follow.current = true
    if (follow.current) toEnd()
  }, [text])
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const end = el.scrollHeight - el.scrollTop - el.clientHeight < 24
    follow.current = end; setAtEnd(end)
  }
  return (
    <div style={{ position: 'relative' }}>
      <pre ref={ref} onScroll={onScroll} style={{ margin: 0, height, overflow: 'auto', padding: 14, borderRadius: 12, background: '#13304A',
                              border: '1px solid #1F4866', color: '#DCE6EF', fontFamily: font.mono, fontSize: 12,
                              lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {text ? text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l, i) => (
          <div key={i} style={{ ...lineStyle(l), padding: '0 4px', borderRadius: 3 }}>{l || ' '}</div>
        )) : '—'}
      </pre>
      {!atEnd && (
        <button onClick={toEnd} title="Jump to the newest line and follow it"
          style={{ position: 'absolute', right: 14, bottom: 12, padding: '5px 11px', borderRadius: 999, border: '1px solid #3B6A8F',
                   background: '#1F4866', color: '#DCE6EF', fontFamily: 'inherit', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                   boxShadow: '0 4px 12px rgba(0,0,0,.3)' }}>
          ↓ Latest
        </button>
      )}
    </div>
  )
}

export function ScreenDeployments() {
  const mayChange = canChange(useAuth().role)
  const [stacks, setStacks] = useState<Stack[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [params] = useSearchParams()
  const [sel, setSel] = useState<string>(() => params.get('stack') || localStorage.getItem('deploy.sel') || '')
  const [filter, setFilter] = useState('')
  const [jobs, setJobs] = useState<Job[]>([])
  const [err, setErr] = useState('')
  const [tab, setTab] = useState<'log' | 'components' | 'results' | 'history' | 'configs'>(
    () => (['log', 'components', 'results', 'history', 'configs'].includes(params.get('tab') || '') ? params.get('tab') : 'log') as 'log')
  const linkedComponent = params.get('component') || ''
  useEffect(() => {
    const st = params.get('stack'), tb = params.get('tab')
    if (st) setSel(st)
    if (tb && ['log', 'components', 'results', 'history', 'configs'].includes(tb)) setTab(tb as 'log')
  }, [params])

  const loadStacks = useCallback(async (refresh = false) => {
    try {
      const r = await api<{ groups: string[]; stacks: Stack[] }>(`/stacks${refresh ? '?refresh=1' : ''}`)
      setStacks(r.stacks); setGroups(r.groups)
      const first = r.groups.map((g) => r.stacks.find((x) => x.group === g)).find(Boolean)
      setSel((s) => (s && r.stacks.some((x) => x.name === s) ? s : first?.name || ''))
    } catch (e) { setErr(String((e as Error).message)) }
  }, [])
  const loadJobs = useCallback(async () => {
    try { setJobs(await api<Job[]>('/jobs?limit=60')) } catch {  }
  }, [])

  useEffect(() => { loadStacks(); loadJobs() }, [loadStacks, loadJobs])
  useEffect(() => { try { localStorage.setItem('deploy.sel', sel) } catch {  } }, [sel])

  const active = jobs.find((j) => j.state === 'running' || j.state === 'orphaned')
  useEffect(() => {
    const t = setInterval(() => { loadJobs(); loadStacks() }, active ? 2000 : 8000)
    return () => clearInterval(t)
  }, [active, loadJobs, loadStacks])

  const stack = stacks.find((s) => s.name === sel)
  const stackJobs = jobs.filter((j) => j.stack === sel)
  const lastJob = stackJobs[0]

  const start = async (action: string) => {
    setErr('')
    try {
      await api<Job>(`/stacks/${sel}/${action}`, { method: 'POST', body: JSON.stringify({}) })
      setTab('log'); loadJobs()
    } catch (x) { setErr(String((x as Error).message)) }
  }
  const cancel = async (id: string) => {
    try { await api(`/jobs/${id}/cancel`, { method: 'POST' }); loadJobs() } catch (x) { setErr(String((x as Error).message)) }
  }

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return stacks.filter((s) => !f || s.name.includes(f) || s.desc.toLowerCase().includes(f))
  }, [stacks, filter])

  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader title="Deployments"
        actions={<Btn onClick={() => { loadStacks(true); loadJobs() }}>Refresh</Btn>} />

      {active && (
        <Card pad={14} style={{ display: 'flex', alignItems: 'center', gap: 14, borderColor: SEL_BORDER }}>
          <span style={{ width: 9, height: 9, borderRadius: '50%', background: C.teal, animation: 'sk-pulse 1.2s infinite' }} />
          <span style={{ fontWeight: 700 }}>{active.action} · {active.stack}</span>
          <span style={{ color: C.mut, fontSize: 13 }}>running {dur(active)} · started by {active.user}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {active.stack !== sel && <Btn onClick={() => { setSel(active.stack); setTab('log') }}>Open</Btn>}
            <Btn danger onClick={() => cancel(active.id)}>Cancel</Btn>
          </span>
        </Card>
      )}
      {err && (
        <Card pad={12} style={{ borderColor: 'rgba(179,39,44,.35)', color: C.bad, fontSize: 13.5 }}>{err}</Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 340px) 1fr', gap: 20, alignItems: 'start' }}>
        <Card pad={14} style={{ position: 'sticky', top: 12 }}>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter stacks…"
            style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: `1px solid ${C.line}`, background: C.well,
                     color: C.ink, fontSize: 13.5, fontFamily: 'inherit', outline: 'none', marginBottom: 10 }} />
          <div style={{ maxHeight: 'calc(100vh - 260px)', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map((g) => {
              const inG = shown.filter((s) => s.group === g)
              if (!inG.length) return null
              return (
                <div key={g}>
                  <div style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: C.faint,
                                fontWeight: 700, margin: '4px 6px 6px' }}>{g}</div>
                  {inG.map((s) => {
                    const on = s.name === sel
                    return (
                      <button key={s.name} onClick={() => setSel(s.name)} title={s.desc}
                        style={{ display: 'block', width: '100%', textAlign: 'left', padding: '9px 10px', borderRadius: 10,
                                 cursor: 'pointer', fontFamily: 'inherit', marginBottom: 2,
                                 background: on ? SEL_BG : 'transparent',
                                 border: `1px solid ${on ? SEL_BORDER : 'transparent'}` }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, fontSize: 13.5, color: on ? C.navy : C.ink,
                                         fontFamily: font.label }}>{s.name}</span>
                          {s.running && <span title="running" style={{ width: 7, height: 7, borderRadius: '50%', background: C.ok }} />}
                          {(s.build?.state === 'built' || s.build?.state === 'failed') && (
                            <span title={s.build.state === 'built' ? 'built' : 'build failed'}
                              style={{ marginLeft: 'auto', width: 8, height: 8, borderRadius: '50%', background: s.build.state === 'built' ? C.ok : C.bad }} />
                          )}
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </Card>

        {stack ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
            <Card>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 24, fontWeight: 700, fontFamily: font.label, letterSpacing: '-.02em' }}>{stack.name}</span>
                <Chip color={C.rose}>{stack.group}</Chip>
                <ServerLights on={stack.running_on ?? []} />
                {stack.doc && (
                  <a href={stack.doc} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', color: C.teal }}>
                    Tutorial ↗
                  </a>
                )}
              </div>
              <div style={{ color: C.mut, marginTop: 8, fontSize: 14.5, lineHeight: 1.55 }}>{stack.desc}</div>
              {stack.error ? (
                <div style={{ color: C.bad, marginTop: 12, fontFamily: font.mono, fontSize: 12 }}>{stack.error}</div>
              ) : (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
                  {stack.ocudu_branch && <Chip color={C.navy}>OCUDU-RAN · {stack.ocudu_branch}</Chip>}
                  {stack.oai_branch && <Chip color={C.navy}>OAI-RAN · {stack.oai_branch}</Chip>}
                </div>
              )}
              <Placement stack={stack.name} running={stack.running} onMoved={() => loadStacks(true)} />

              <div style={{ display: 'flex', gap: 10, marginTop: 18, flexWrap: 'wrap', alignItems: 'center' }}>
                {mayChange && ACTIONS.filter((a) => a.key !== 'train' || stack.trainable).map((a) => {
                  const b = a.key === 'build' ? stack.build : undefined
                  return (
                    <Btn key={a.key} primary={a.primary} danger={a.danger}
                      tone={b?.state === 'built' ? 'ok' : b?.state === 'failed' ? 'bad' : undefined}
                      title={active && !(a.key === 'stop' && active.stack !== sel)
                        ? `busy: ${active.action} ${active.stack}`
                        : b?.state === 'built' ? `built${b.at ? ` ${ago(b.at)}` : ''}`
                        : b?.state === 'failed' ? 'build failed' : a.hint}
                      disabled={!!active && !(a.key === 'stop' && active.stack !== sel)}
                      onClick={() => start(a.key)}>
                      {b?.state === 'built' ? 'Built' : b?.state === 'failed' ? 'Build' : b?.state === 'building'
                        ? <><span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: C.teal, marginRight: 7,
                                           animation: 'sk-pulse 1.2s infinite' }} />Building</> : a.label}
                    </Btn>
                  )
                })}
              </div>
            </Card>

            <Card pad={16}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
                {(['configs', 'log', 'components', 'results', 'history'] as const).map((t) => (
                  <button key={t} onClick={() => setTab(t)}
                    style={{ padding: '7px 14px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
                             color: tab === t ? C.ink : C.mut, background: tab === t ? SEL_BG : 'transparent',
                             border: `1px solid ${tab === t ? SEL_BORDER : 'transparent'}` }}>
                    {{ configs: 'Configs', log: 'Job log', components: 'Components', results: 'Results', history: 'History' }[t]}
                  </button>
                ))}
              </div>
              {tab === 'log' && <JobLog job={lastJob} onCancel={cancel} />}
              {tab === 'components' && <Components stack={stack} initial={stack.name === params.get('stack') ? linkedComponent : ''} />}
              {tab === 'results' && <Results stack={stack.name} />}
              {tab === 'configs' && <Configs stack={stack.name} components={stack.components || []} onSaved={() => loadStacks(true)} />}
              {tab === 'history' && <History jobs={stackJobs} />}
            </Card>
          </div>
        ) : (
          <Card><span style={{ color: C.mut }}>No stacks found.</span></Card>
        )}
      </div>
    </div>
  )
}

const inputStyle = (w: number): React.CSSProperties => ({
  ...(w ? { width: w } : {}), padding: '8px 11px', borderRadius: 9, border: `1px solid ${C.line}`, background: C.well,
  color: C.ink, fontSize: 13, fontFamily: font.mono, outline: 'none',
})

function JobLog({ job, onCancel }: { job?: Job; onCancel: (id: string) => void }) {
  const [text, setText] = useState('')
  const [state, setState] = useState<Job | undefined>(job)
  const off = useRef(0)
  useEffect(() => { setText(''); off.current = 0; setState(job) }, [job?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!job) return
    let live = true
    const tick = async () => {
      try {
        const r = await api<Job & { log: string; offset: number }>(`/jobs/${job.id}?offset=${off.current}`)
        if (!live) return
        if (r.log) setText((t) => t + r.log)
        off.current = r.offset
        setState(r)
        if (r.state === 'running') setTimeout(tick, 1000)
      } catch { if (live) setTimeout(tick, 3000) }
    }
    tick()
    return () => { live = false }
  }, [job?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!job) return <div style={{ color: C.mut, fontSize: 13.5 }}>No jobs yet.</div>
  const s = state || job
  const all = text.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const endCheck = all.findIndex((l) => /system requirements met|requirement\(s\) not met/.test(l))
  const plain = endCheck < 0 ? all : all.slice(0, endCheck + 1)
  const met = plain.filter((l) => /^\s+ok\s/.test(l)).length
  const unmet = plain.filter((l) => /^\s+no\s/.test(l)).map((l) => l.replace(/^\s+no\s+/, ''))
  return (
    <div>
      {(met > 0 || unmet.length > 0) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10, padding: '10px 12px', borderRadius: 10,
                      background: unmet.length ? 'rgba(179,39,44,.07)' : 'rgba(15,138,95,.07)',
                      border: `1px solid ${unmet.length ? 'rgba(179,39,44,.3)' : 'rgba(15,138,95,.3)'}` }}>
          <span style={{ fontWeight: 800, color: unmet.length ? C.bad : C.ok }}>
            {unmet.length ? `${unmet.length} requirement${unmet.length > 1 ? 's' : ''} not met` : 'All requirements met'}
          </span>
          <span style={{ color: C.mut, fontSize: 13 }}>{met} ok</span>
          {unmet.map((u) => <span key={u} style={{ padding: '3px 9px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                                                     color: C.bad, background: '#fff', border: '1px solid rgba(179,39,44,.35)' }}>{u}</span>)}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
        <StatusPill label={s.state} {...TONE[s.state]} />
        <span style={{ fontFamily: font.label, fontSize: 12.5, color: C.mut }}>{s.cmd}</span>
        <span style={{ color: C.faint, fontSize: 12.5 }}>{dur(s)} · {ago(s.started)} · {s.user}</span>
        {(s.state === 'running' || s.state === 'orphaned') && <span style={{ marginLeft: 'auto' }}><Btn danger onClick={() => onCancel(s.id)}>Cancel</Btn></span>}
      </div>
      <Console text={text} height={440} />
    </div>
  )
}

function Components({ stack, initial = '' }: { stack: Stack; initial?: string }) {
  const [rows, setRows] = useState<Comp[]>([])
  const [pick, setPick] = useState(initial)
  const [log, setLog] = useState('')
  useEffect(() => {
    let live = true
    const tick = () => api<{ components: Comp[] }>(`/stacks/${stack.name}/status`)
      .then((r) => live && setRows(r.components)).catch(() => {})
    tick()
    const t = setInterval(tick, 4000)
    return () => { live = false; clearInterval(t) }
  }, [stack.name])
  useEffect(() => {
    if (!pick) return
    let live = true
    const tick = () => api<{ log: string }>(`/stacks/${stack.name}/logs/${pick}?lines=400`)
      .then((r) => live && setLog(r.log)).catch(() => {})
    tick()
    const t = setInterval(tick, 3000)
    return () => { live = false; clearInterval(t) }
  }, [stack.name, pick])
  const names = rows.length ? rows : (stack.start_order || []).map((n) => ({ name: n, state: 'down' as const, pid: null }))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 280px) 1fr', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {names.map((c) => (
          <button key={c.name} onClick={() => setPick(c.name)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderRadius: 10, cursor: 'pointer',
                     fontFamily: 'inherit', textAlign: 'left',
                     background: pick === c.name ? SEL_BG : C.well,
                     border: `1px solid ${pick === c.name ? SEL_BORDER : C.line}` }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: TONE[c.state].fg }} />
            <span style={{ fontFamily: font.label, fontSize: 13, color: C.ink, flex: 1 }}>{c.name}</span>
            {stack.hosts?.[c.name] && <span title="runs on" style={{ fontSize: 11.5, fontWeight: 700, color: C.navy, background: 'rgba(96,147,186,.14)', padding: '2px 8px', borderRadius: 999 }}>{stack.hosts[c.name]}</span>}
            <span style={{ fontSize: 12, color: TONE[c.state].fg, fontWeight: 700 }}>{c.state}</span>
          </button>
        ))}
      </div>
      {pick ? <Console text={log} height={420} />
        : <div style={{ color: C.mut, fontSize: 13.5, alignSelf: 'center' }}>Pick a component.</div>}
    </div>
  )
}

function Results({ stack }: { stack: string }) {
  const [runs, setRuns] = useState<ResultRun[] | null>(null)
  useEffect(() => {
    api<{ runs: ResultRun[] }>(`/stacks/${stack}/results`).then((r) => setRuns(r.runs)).catch(() => setRuns([]))
  }, [stack])
  const download = async (run: string, name: string) => {
    const r = await fetch(`/api/deploy/stacks/${stack}/results/${run}/${name}`, { headers: authHeader() })
    if (!r.ok) return
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a')
    a.href = url; a.download = `${stack}-${run}-${name}`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  if (runs === null) return <div style={{ color: C.mut }}>Loading…</div>
  if (!runs.length) return <div style={{ color: C.mut, fontSize: 13.5 }}>No results yet.</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {runs.map((r) => (
        <div key={r.run} style={{ padding: '12px 14px', borderRadius: 12, background: C.well, border: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: font.label, fontSize: 13, color: C.ink, fontWeight: 600 }}>{r.run}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {r.files.map((f) => (
              <button key={f.name} onClick={() => download(r.run, f.name)}
                style={{ padding: '6px 11px', borderRadius: 8, cursor: 'pointer', fontFamily: font.mono, fontSize: 12,
                         color: C.teal, background: SEL_BG, border: `1px solid ${SEL_BORDER}` }}>
                ↓ {f.name} <span style={{ color: C.faint }}>{f.bytes < 1024 ? `${f.bytes} B` : `${(f.bytes / 1024).toFixed(1)} KB`}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function History({ jobs }: { jobs: Job[] }) {
  if (!jobs.length) return <div style={{ color: C.mut, fontSize: 13.5 }}>No jobs yet for this stack.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
      <thead>
        <tr style={{ color: C.faint, textAlign: 'left' }}>
          {['Action', 'State', 'Overrides', 'Duration', 'When', 'By'].map((h) => (
            <th key={h} style={{ padding: '8px 10px', fontWeight: 600, borderBottom: `1px solid ${C.line}` }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id}>
            <td style={td}>{j.action}</td>
            <td style={td}><StatusPill label={j.state} {...TONE[j.state]} /></td>
            <td style={{ ...td, fontFamily: font.mono, color: C.mut }}>
              {Object.entries(j.env || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '—'}
            </td>
            <td style={td}>{dur(j)}</td>
            <td style={{ ...td, color: C.mut }}>{ago(j.started)}</td>
            <td style={{ ...td, color: C.mut }}>{j.user}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
const td: React.CSSProperties = { padding: '9px 10px', borderBottom: `1px solid ${C.line}`, color: C.ink }

interface CfgFile { given: string; path: string; exists: boolean; editable: boolean }
interface Slot { key: string; label: string; value: string; files: CfgFile[]; pick: boolean }
interface Source { repo: string; branch: string; upstream: string; upstream_exists: boolean; using: string }
type CfgData = { slots: Slot[]; knobs: Knob[]; settings: Record<string, string>; file: string; source: Source | null; choices: string[]
  core: CoreInfo | null }
const knobWhen = (k: Knob) => k.label.match(/\((\w+)=([\w-]+)\)/)
interface Knob { key: string; label: string; help: string; choices: string[]; value: string }

const hostKey = (c: string) => `HOST_${c.toUpperCase().replace(/-/g, '_')}`

function Configs({ stack, components, onSaved }: { stack: string; components: string[]; onSaved: () => void }) {
  const [servers, setServers] = useState<Host[]>([])
  useEffect(() => { hostsApi<{ hosts: Host[] }>('').then((r) => setServers(r.hosts)).catch(() => {}) }, [])
  const [data, setData] = useState<CfgData | null>(null)
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [rows, setRows] = useState<{ k: string; v: string }[]>([])
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [edit, setEdit] = useState<{ slot: string; path: string } | null>(null)
  const load = useCallback(() => api<CfgData>(`/stacks/${stack}/configs`)
    .then((r) => {
      setData(r); setDraft({})
      const known = new Set([...r.knobs.map((k) => k.key), ...r.slots.map((x) => x.key), ...components.map(hostKey), 'OCUDU_TREE', 'OCUDU_PREBUILT', ...CORE_FIELDS.map((f) => f.key), 'CORE', 'CORE_CFG_MODE'])
      setRows(Object.entries(r.settings).filter(([k]) => !known.has(k)).map(([k, v]) => ({ k, v })))
    }).catch((e) => setMsg({ ok: false, text: String((e as Error).message) })), [stack, components.join(' ')]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMsg(null); load() }, [load])

  const save = async (patch: Record<string, string>) => {
    if (!data) return
    const settings: Record<string, string> = { ...data.settings, ...patch }
    rows.filter((r) => r.k.trim()).forEach((r) => { settings[r.k.trim()] = r.v })
    try {
      const r = await api<typeof data>(`/stacks/${stack}/settings`, { method: 'PUT', body: JSON.stringify({ settings }) })
      setData(r); setDraft({}); setMsg({ ok: true, text: 'Saved' }); onSaved()
    } catch (e) { setMsg({ ok: false, text: String((e as Error).message) }) }
  }
  if (!data) return <div style={{ color: C.mut }}>{msg?.text || 'Loading…'}</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {msg && <div style={{ fontSize: 13, color: msg.ok ? C.ok : C.bad }}>{msg.text}</div>}

      {!!data.knobs.length && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          {data.knobs.filter((k) => { const w = knobWhen(k); return !w || data.knobs.find((o) => o.key === w[1])?.value === w[2] }).map((k) => (
            <label key={k.key} style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12.5, color: C.mut }}>
              <span style={{ fontWeight: 700, color: C.ink }}>{k.label.replace(/\s*\(\w+=[\w-]+\)/, '')}</span>
              <select value={k.value} onChange={(e) => save({ [k.key]: e.target.value })}
                style={{ ...inputStyle(220), fontFamily: font.mono }}>
                {k.choices.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {data.slots.map((sl) => (
          <div key={sl.key} style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 14px', background: C.card }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontWeight: 800, fontSize: 14 }}>{sl.label}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
              {sl.files.map((f) => (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 10px', borderRadius: 9, background: C.well }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: f.exists ? C.ok : C.bad, flex: '0 0 8px' }} title={f.exists ? 'found' : 'missing'} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: font.label, fontSize: 13, fontWeight: 700 }} title={f.path}>{f.path.split('/').pop()}</div>
                  </div>
                  {!f.exists && <span style={{ fontSize: 12, fontWeight: 700, color: C.bad }}>missing</span>}
                  {f.editable && <Btn onClick={() => setEdit({ slot: sl.key, path: f.path })}>Edit</Btn>}
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
              <input value={draft[sl.key] ?? sl.value} onChange={(e) => setDraft({ ...draft, [sl.key]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && save({ [sl.key]: draft[sl.key] ?? sl.value })}
                placeholder="path" style={{ ...inputStyle(0), flex: 1 }} />
              {sl.pick && !!data.choices.length && !(sl.key === 'OCUDU_CFG' && data.slots.some((x) => x.key === 'RADIO_CFG')) && (
                <select value="" onChange={(e) => { const rest = (draft[sl.key] ?? sl.value).split(/\s+/).slice(1)
                                                    setDraft({ ...draft, [sl.key]: [e.target.value, ...rest].join(' ') }) }}
                  style={{ ...inputStyle(200), fontFamily: font.mono }}>
                  <option value="" disabled>Choose config…</option>
                  {data.choices.map((c) => <option key={c} value={c}>{c.startsWith('/') ? `${c.split('/').pop()} · saved copy` : c}</option>)}
                </select>
              )}
              {draft[sl.key] !== undefined && draft[sl.key] !== sl.value && (
                <>
                  <Btn primary onClick={() => save({ [sl.key]: draft[sl.key] })}>Use these paths</Btn>
                  <Btn onClick={() => setDraft(Object.fromEntries(Object.entries(draft).filter(([k]) => k !== sl.key)))}>Cancel</Btn>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {data.core && <CorePicker core={data.core} settings={data.settings} onSave={save} />}
      {data.source && <SourcePicker source={data.source} settings={data.settings} onSave={save} />}

      <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '12px 14px', background: C.card }}>
        <div style={{ fontWeight: 800, fontSize: 14, marginBottom: 8 }}>Servers</div>
        {components.map((c) => {
          const k = hostKey(c), saved = data.settings[k] || ''
          const v = draft[k] ?? saved
          return (
            <div key={c} style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
              <span style={{ fontFamily: font.label, fontSize: 13, width: 130 }}>{c}</span>
              <select value={v} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} style={{ ...inputStyle(0), flex: 1 }}>
                <option value="">primary (this server)</option>
                {servers.map((h) => <option key={h.id} value={target(h)}>{h.nickname} · {target(h)}</option>)}
                {v && !servers.some((h) => target(h) === v) && <option value={v}>{v}</option>}
              </select>
              {v !== saved && <Btn primary onClick={() => save({ [k]: v })}>Save</Btn>}
            </div>
          )
        })}
      </div>

      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>Other settings</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Btn onClick={() => setRows([...rows, { k: '', v: '' }])}>+ Add</Btn>
            <Btn primary onClick={() => save({})}>Save settings</Btn>
          </span>
        </div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input value={r.k} placeholder="KEY" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, k: e.target.value.toUpperCase() } : x)))} style={inputStyle(220)} />
            <input value={r.v} placeholder="value" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} style={{ ...inputStyle(0), flex: 1 }} />
            <Btn onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</Btn>
          </div>
        ))}
      </div>

      {edit && <Editor stack={stack} {...edit} onClose={(changed) => { setEdit(null); if (changed) { load(); onSaved() } }} />}
    </div>
  )
}

function Editor({ stack, slot, path, onClose }: { stack: string; slot: string; path: string; onClose: (changed: boolean) => void }) {
  const [text, setText] = useState<string | null>(null)
  const [orig, setOrig] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    api<{ content: string }>(`/stacks/${stack}/file?path=${encodeURIComponent(path)}`)
      .then((r) => { setText(r.content); setOrig(r.content) }).catch((e) => setMsg({ ok: false, text: String((e as Error).message) }))
  }, [stack, path])
  const dirty = text !== null && text !== orig
  const save = async (asCopy: boolean) => {
    try {
      const r = await api<{ saved: string; backup?: string }>(`/stacks/${stack}/file`, {
        method: 'PUT', body: JSON.stringify({ path, content: text, as_copy: asCopy, slot }) })
      setMsg({ ok: true, text: asCopy ? `Saved as ${r.saved}` : 'Saved' })
      setOrig(text ?? '')
      if (asCopy) setTimeout(() => onClose(true), 900)
    } catch (e) { setMsg({ ok: false, text: String((e as Error).message) }) }
  }
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(14,24,32,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={() => !dirty && onClose(false)}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(1100px, 94vw)', height: '86vh', background: C.card, borderRadius: 16, padding: 18, display: 'flex', flexDirection: 'column', gap: 10,
                 boxShadow: '0 30px 80px -30px rgba(39,85,120,.6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 800 }}>{path.split('/').pop()}</span>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: C.faint, wordBreak: 'break-all' }}>{path}</span>
          {dirty && <span style={{ fontSize: 12, fontWeight: 700, color: C.warn }}>unsaved</span>}
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Btn disabled={!dirty} primary onClick={() => save(false)} title="overwrite this file; the old one goes to var/config-backups/">Save</Btn>
            <Btn disabled={text === null} onClick={() => save(true)} title="write var/configs/<stack>/ and point this config slot at it">Save as copy &amp; use</Btn>
            <Btn onClick={() => (!dirty || confirm('Discard your changes?')) && onClose(false)}>Close</Btn>
          </span>
        </div>
        {msg && <div style={{ fontSize: 13, color: msg.ok ? C.ok : C.bad }}>{msg.text}</div>}
        <textarea value={text ?? ''} onChange={(e) => setText(e.target.value)} spellCheck={false} disabled={text === null}
          style={{ flex: 1, resize: 'none', padding: 14, borderRadius: 12, border: `1px solid ${C.line}`, background: '#13304A', color: '#DCE6EF',
                   fontFamily: font.mono, fontSize: 13, lineHeight: 1.55, outline: 'none', tabSize: 2 }} />
      </div>
    </div>,
    document.body,
  )
}

const home = (p: string) => p.replace(/^\/home\/[^/]+/, '~')

const CORES = [
  { key: 'oai-cn5g', label: 'OAI CN5G', sub: 'docker compose' },
  { key: 'sd-core', label: 'SD-Core', sub: 'RKE2' },
  { key: 'external', label: 'External', sub: 'your own' },
]
const CORE_FIELDS = [
  { key: 'CORE_AMF_ADDR', label: 'AMF address', w: 170 }, { key: 'CORE_PLMN', label: 'PLMN', w: 90 },
  { key: 'CORE_TAC', label: 'TAC', w: 60 }, { key: 'CORE_SST', label: 'SST', w: 60 }, { key: 'CORE_SD', label: 'SD (hex)', w: 90 },
]
const CORE_MODES = [
  { key: 'default', label: 'Core defaults' }, { key: 'files', label: 'My config files' }, { key: 'custom', label: 'Custom' },
]
type CoreInfo = { value: string; fixed: boolean; mode: string; defaults: Record<string, Record<string, string>> }

function CorePicker({ core, settings, onSave }: { core: CoreInfo; settings: Record<string, string>; onSave: (p: Record<string, string>) => void }) {
  const saved = { kind: settings.CORE || core.value, mode: core.mode, f: Object.fromEntries(CORE_FIELDS.map((f) => [f.key, settings[f.key] ?? ''])) }
  const [kind, setKind] = useState(saved.kind)
  const [mode, setMode] = useState(saved.mode)
  const [f, setF] = useState<Record<string, string>>(saved.f)
  const reset = () => { setKind(saved.kind); setMode(saved.mode); setF(saved.f) }
  useEffect(reset, [JSON.stringify(settings), core.value, core.mode]) // eslint-disable-line react-hooks/exhaustive-deps
  const pickKind = (k: string) => {
    if (core.fixed || k === kind) return
    setKind(k); setF(Object.fromEntries(CORE_FIELDS.map((x) => [x.key, ''])))
    if (k === 'external' && mode === 'default') setMode('custom')
  }
  const def = core.defaults[kind] ?? {}
  const dirty = kind !== saved.kind || mode !== saved.mode || CORE_FIELDS.some((x) => (f[x.key] ?? '') !== saved.f[x.key])
  const bad = mode === 'custom' && kind === 'external' && !f.CORE_AMF_ADDR?.trim()
  const save = () => onSave({ ...(core.fixed ? {} : { CORE: kind }), CORE_CFG_MODE: mode,
                              ...Object.fromEntries(CORE_FIELDS.map((x) => [x.key, mode === 'custom' ? (f[x.key] ?? '').trim() : ''])) })
  const seg = (on: boolean): React.CSSProperties => ({ padding: '5px 12px', border: 'none', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5,
    fontWeight: 700, background: on ? '#fff' : 'transparent', color: on ? C.ink : C.mut, boxShadow: on ? '0 1px 3px rgba(0,0,0,.12)' : 'none' })
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '14px 16px', background: C.card }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>5G core</span>
        {dirty && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Btn onClick={reset}>Discard</Btn>
            <Btn primary disabled={bad} onClick={save}>Save</Btn>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {CORES.filter((c) => !core.fixed || c.key === kind).map((c) => (
          <button key={c.key} onClick={() => pickKind(c.key)}
            style={{ flex: 1, minWidth: 150, textAlign: 'left', padding: '11px 13px', borderRadius: 12, cursor: core.fixed ? 'default' : 'pointer', fontFamily: 'inherit',
                     background: kind === c.key ? SEL_BG : C.card, border: `1.5px solid ${kind === c.key ? C.teal : C.line}` }}>
            <div style={{ fontWeight: 700, fontSize: 13.5 }}>{c.label}</div>
            <div style={{ fontSize: 12, color: C.mut, marginTop: 3 }}>{c.sub}</div>
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: C.mut }}>AMF, PLMN, TAC, slice from</span>
        <span style={{ display: 'inline-flex', background: C.well, borderRadius: 9, padding: 3, gap: 2 }}>
          {CORE_MODES.filter((m) => !(m.key === 'default' && kind === 'external')).map((m) => (
            <button key={m.key} onClick={() => setMode(m.key)} style={seg(mode === m.key)}>{m.label}</button>
          ))}
        </span>
      </div>
      {mode === 'files' ? (
        <div style={{ fontSize: 12.5, color: C.mut, marginTop: 10 }}>From the config files</div>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}>
          {CORE_FIELDS.map((x) => (
            <label key={x.key} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: C.mut, fontWeight: 700 }}>
              {x.label}
              {mode === 'default'
                ? <span style={{ ...inputStyle(x.w), fontFamily: font.mono, display: 'inline-block', background: 'transparent', color: C.ink }}>{def[x.key] || '—'}</span>
                : <input value={f[x.key] ?? ''} onChange={(e) => setF({ ...f, [x.key]: e.target.value })}
                    placeholder={def[x.key] || (x.key === 'CORE_AMF_ADDR' && kind === 'external' ? 'required' : x.key === 'CORE_PLMN' ? '00101' : x.key === 'CORE_SD' ? 'none' : '1')}
                    style={{ ...inputStyle(x.w), fontFamily: font.mono, borderColor: x.key === 'CORE_AMF_ADDR' && bad ? C.bad : undefined }} />}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}

function SourcePicker({ source, settings, onSave }: { source: Source; settings: Record<string, string>; onSave: (p: Record<string, string>) => void }) {
  const saved = { tree: settings.OCUDU_TREE ?? '', pre: settings.OCUDU_PREBUILT === 'yes' }
  const [local, setLocal] = useState(!!saved.tree)
  const [tree, setTree] = useState(saved.tree)
  const [pre, setPre] = useState(saved.pre)
  useEffect(() => { setLocal(!!saved.tree); setTree(saved.tree); setPre(saved.pre) }, [saved.tree, saved.pre])
  const want = local ? tree.trim() : ''
  const dirty = want !== saved.tree || pre !== saved.pre
  const card = (on: boolean): React.CSSProperties => ({
    flex: 1, minWidth: 0, textAlign: 'left', padding: '12px 14px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
    background: on ? SEL_BG : C.card, border: `1.5px solid ${on ? C.teal : C.line}`, transition: 'border-color .15s, background .15s',
  })
  const dot = (on: boolean) => (
    <span style={{ width: 16, height: 16, flex: '0 0 16px', borderRadius: '50%', border: `2px solid ${on ? C.teal : '#B9C7CC'}`,
                   display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      {on && <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.teal }} />}
    </span>
  )
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 12, padding: '14px 16px', background: C.card }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>OCUDU source</span>
        {dirty && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <Btn onClick={() => { setLocal(!!saved.tree); setTree(saved.tree); setPre(saved.pre) }}>Discard</Btn>
            <Btn primary onClick={() => onSave({ OCUDU_TREE: want, OCUDU_PREBUILT: pre ? 'yes' : 'no' })}>Save</Btn>
          </span>
        )}
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={() => setLocal(false)} style={card(!local)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{dot(!local)}<span style={{ fontWeight: 700, fontSize: 13.5 }}>Upstream</span>
            <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: C.navy, background: 'rgba(96,147,186,.14)', padding: '2px 8px', borderRadius: 999 }}>{source.branch}</span>
          </div>
          <div style={{ fontSize: 12.5, color: C.mut, marginTop: 6 }}>{source.repo}</div>
          <div style={{ fontFamily: font.mono, fontSize: 11.5, color: source.upstream_exists ? C.faint : C.warn, marginTop: 2,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={source.upstream}>
            {home(source.upstream)}{source.upstream_exists ? '' : ' · fetched on build'}
          </div>
        </button>
        <div onClick={() => setLocal(true)} style={card(local)}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{dot(local)}<span style={{ fontWeight: 700, fontSize: 13.5 }}>Local tree</span></div>
          <input value={tree} onChange={(e) => { setTree(e.target.value); setLocal(true) }} placeholder="/path/to/OCUDU-RAN"
            style={{ ...inputStyle(0), width: '100%', marginTop: 8, background: local ? '#fff' : C.well }} />
        </div>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer', userSelect: 'none' }}>
        <span onClick={() => setPre(!pre)} role="switch" aria-checked={pre}
          style={{ width: 38, height: 22, borderRadius: 999, background: pre ? C.teal : '#CBD6DA', position: 'relative', transition: 'background .15s', flex: '0 0 38px' }}>
          <span style={{ position: 'absolute', top: 3, left: pre ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff',
                         boxShadow: '0 1px 3px rgba(0,0,0,.25)', transition: 'left .15s' }} />
        </span>
        <span onClick={() => setPre(!pre)} style={{ fontSize: 13.5, fontWeight: 600 }}>Use existing build</span>
      </label>
    </div>
  )
}

interface Rank { id: string; nickname: string; score: number; fits: boolean; reasons: string[] }

function ServerLights({ on }: { on: string[] }) {
  const [all, setAll] = useState<Host[]>([])
  useEffect(() => { hostsApi<{ primary: Host; hosts: Host[] }>('').then((r) => setAll([r.primary, ...r.hosts])).catch(() => {}) }, [])
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {all.map((h) => {
        const up = on.includes(target(h))
        return (
          <span key={target(h)} title={`${up ? 'running' : 'not running'} on ${target(h)}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 10px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                     background: up ? 'rgba(15,138,95,.08)' : 'rgba(179,39,44,.06)', color: up ? C.ok : C.bad,
                     border: `1px solid ${up ? 'rgba(15,138,95,.28)' : 'rgba(179,39,44,.22)'}` }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: up ? C.ok : C.bad }} />{h.nickname}
          </span>
        )
      })}
    </span>
  )
}

function Placement({ stack, running, onMoved }: { stack: string; running: boolean; onMoved: () => void }) {
  const [p, setP] = useState<{ current: string[]; ranking: Rank[] } | null>(null)
  const [err, setErr] = useState('')
  const load = useCallback(() => hostsApi<{ current: string[]; ranking: Rank[] }>(`/placement/${stack}`).then(setP).catch(() => setP(null)), [stack])
  useEffect(() => { setErr(''); load() }, [load])
  if (!p) return null
  const split = p.current.length > 1
  const best = p.ranking.find((r) => r.fits)
  const move = async (id: string) => {
    setErr('')
    try { setP(await hostsApi(`/placement/${stack}`, { method: 'POST', body: JSON.stringify({ host: id }) })); onMoved() }
    catch (e) { setErr((e as Error).message) }
  }
  return (
    <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 12.5, fontWeight: 700, color: C.faint, marginRight: 2 }}>Runs on</span>
      {p.ranking.map((r) => {
        const on = !split && p.current[0] === r.id
        return (
          <button key={r.id} disabled={running || on || !r.fits} onClick={() => move(r.id)}
            title={r.fits ? (on ? 'current server' : `move ${stack} here`) : `${on ? 'current server -- ' : ''}${r.reasons.join(', ')}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 999, fontSize: 12.5, fontWeight: 700,
                     fontFamily: 'inherit', cursor: running || on || !r.fits ? 'default' : 'pointer',
                     color: on ? '#fff' : r.fits ? C.ink : C.faint, background: on ? C.teal : r.fits ? C.card : C.well,
                     border: `1px solid ${on ? C.teal : C.line}`, opacity: r.fits || on ? 1 : 0.6, textDecoration: r.fits || on ? 'none' : 'line-through' }}>
            {r.nickname}
            {best?.id === r.id && !on && <span style={{ fontSize: 10.5, fontWeight: 800, color: C.ok }}>best fit</span>}
          </button>
        )
      })}
      {split && <span style={{ fontSize: 12, fontWeight: 700, color: C.navy }}>split · {p.current.length} servers</span>}
      {err && <span style={{ fontSize: 12, color: C.bad }}>{err}</span>}
    </div>
  )
}
