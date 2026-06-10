import { UserChip } from '../components/TopBar'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card } from '../components/ui'
import { Icon } from '../components/Icon'
import { Thumb, type Scene } from '../components/HomeParts'
import { authHeader } from '../lib/auth'
import { font, palette } from '../styles/theme'

interface Run { id: string; stack: string; started: number; outcome: string; csvs?: number; rows?: number }
interface Model { id: string; name: string; stack: string | null; feature?: string; source: string; exists: boolean
  bytes?: number; mtime: number | null; in_use_by?: string | null }
interface LakeStack { stack: string; group: string; runs: number; csvs: number; rows: number; bytes: number; last: number | null }
interface Bench { id: string; t: number; stack: string; model: string; kind: string; metric: string; unit: string
  lower_is_better: boolean; results: { name: string; value: number; model: boolean }[] }
interface MlState { lifecycle: { mode: string }; features: { label: string; algo: string; mode: string }[] }
interface Specs { cpu?: string; cores?: number; isolated?: string; mem_gb?: number; hugepages_gb?: number; disk_free_gb?: number
  gpus?: string[]; gpu_use?: string[]; dpdk?: string; ptp?: string; docker?: string; os?: string; stacks?: string[] }
interface Host { id: string; nickname: string; address: string; user: string; port?: number; primary?: boolean
  specs?: Specs; test?: { ping_ms?: number; ssh?: boolean; sudo?: boolean; at?: number; error?: string } }
interface AgentRow { key: string; label: string; live: { user: string; status: string; pending: number }[]
  conversations: number; actions: number; actions_today: number; outcomes: Record<string, number>
  top_tools: [string, number][]; users: string[]; last: number | null; daily: number[]
  calls: number; tokens_in: number; tokens_out: number; avg_ms: number | null }
interface Summary { llm: { model: string; provider: string }; agents: AgentRow[]; days: number[]
  recent: { id: string; agent: string; user: string; title: string; updated: number; messages: number; tools: number; open: boolean }[]
  activity: { t: number; user: string; agent: string; tool: string; summary: string; outcome: string }[]
  totals: { running: number; waiting: number; actions_today: number; approved_today: number; tokens_today: number; calls_today: number } }

const INK = '#0E1820', MUT = '#5B6E77', DIM = '#84969E', LINE = 'rgba(14,40,52,.08)', BAD = '#B3272C', WARN = '#B07908'
const GLASS: React.CSSProperties = { background: 'rgba(255,255,255,.66)', border: '1px solid rgba(255,255,255,.72)', borderRadius: 14,
  boxShadow: '0 14px 30px -14px rgba(16,40,50,.22)' }
const PANE: React.CSSProperties = { background: 'rgba(255,255,255,.62)', border: '1px solid rgba(255,255,255,.7)', borderRadius: 13 }
const TEAL = palette.teal
const get = <X,>(p: string): Promise<X> => fetch(p, { headers: authHeader() }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
const ago = (t?: number | null) => {
  if (!t) return '—'
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`
}
const num = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n))
const bytes = (n?: number) => (!n ? '0 B' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.round(n / 1e3)} kB`)

function usePoll<X>(url: string | null, ms: number): X | null {
  const [d, setD] = useState<X | null>(null)
  useEffect(() => {
    if (!url) return
    let on = true
    const pull = () => get<X>(url).then((r) => on && setD(r)).catch(() => {})
    pull()
    const iv = window.setInterval(pull, ms)
    return () => { on = false; window.clearInterval(iv) }
  }, [url, ms])
  return d
}

function Box({ title, to, extra, children, style }: { title: string; to: string; extra?: React.ReactNode; children: React.ReactNode; style?: React.CSSProperties }) {
  const nav = useNavigate()
  return (
    <Card pad={0} style={{ ...GLASS, overflow: 'hidden', minWidth: 0, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 18px 12px' }}>
        <span style={{ fontWeight: 800, fontSize: 16, color: INK }}>{title}</span>
        {extra}
        <button onClick={() => nav(to)} style={{ marginLeft: 'auto', border: 0, background: 'none', cursor: 'pointer', fontSize: 12.5,
          fontWeight: 700, color: TEAL, fontFamily: 'inherit', padding: 0 }}>Open</button>
      </div>
      {children}
    </Card>
  )
}

const line: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 18px', borderTop: `1px solid ${LINE}`, fontSize: 13.5, minWidth: 0 }
const right: React.CSSProperties = { marginLeft: 'auto', color: MUT, fontSize: 12.5, whiteSpace: 'nowrap' }
const ell: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }
const dot = (c: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: c, flex: '0 0 8px' })

function Chip({ children, tone = 'mut' }: { children: React.ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'mut' | 'brand' }) {
  const c = { ok: ['#E6EFF0', TEAL], warn: ['#FDF1DF', WARN], bad: ['#FDECEC', BAD], mut: ['#F1F5F6', MUT], brand: [TEAL, '#fff'] }[tone]
  return <span style={{ fontSize: 11.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: c[0], color: c[1], whiteSpace: 'nowrap' }}>{children}</span>
}

function Tile({ k, v, sub, tone }: { k: string; v: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div style={{ padding: '12px 16px', minWidth: 0 }}>
      <div style={{ fontSize: 12, color: MUT, fontWeight: 600 }}>{k}</div>
      <div style={{ fontSize: 20, fontWeight: 800, marginTop: 2, color: tone || INK, ...ell }}>{v}</div>
      {sub && <div style={{ fontSize: 11.5, color: DIM, marginTop: 1, ...ell }}>{sub}</div>}
    </div>
  )
}

function TileRow({ children, cols }: { children: React.ReactNode; cols: number }) {
  return <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${cols}px, 1fr))`, borderTop: `1px solid ${LINE}` }}>{children}</div>
}

function Week({ daily, days }: { daily: number[]; days: number[] }) {
  const max = Math.max(1, ...daily)
  const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { weekday: 'long' })
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 22 }}>
      {daily.map((n, i) => (
        <div key={i} title={`${day(days[i])}: ${n} actions`} style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end' }}>
          <div style={{ width: '100%', height: n ? `${Math.max(12, (100 * n) / max)}%` : 2, borderRadius: 2,
            background: !n ? LINE : i === daily.length - 1 ? TEAL : '#B5CFD4' }} />
        </div>
      ))}
    </div>
  )
}

const STATE: Record<string, [string, string]> = {
  running: [TEAL, 'working'], approval: [WARN, 'waiting for you'], error: [BAD, 'error'], idle: ['#B9C7CC', 'idle'],
}

function Agents({ s }: { s: Summary | null }) {
  const nav = useNavigate()
  const t = s?.totals
  const label = (k: string) => s?.agents.find((a) => a.key === k)?.label ?? k
  return (
    <Box title="Agents" to="/agents" extra={s && <Chip tone="mut">{s.llm.model || 'no LLM set'}</Chip>}>
      <TileRow cols={110}>
        <Tile k="Working now" v={t?.running ?? '—'} tone={t?.running ? TEAL : undefined} />
        <Tile k="Waiting for you" v={t?.waiting ?? '—'} tone={t?.waiting ? WARN : undefined} />
        <Tile k="Actions today" v={t?.actions_today ?? '—'} />
        <Tile k="Tokens today" v={t ? num(t.tokens_today) : '—'} />
      </TileRow>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 10, padding: 14, borderTop: `1px solid ${LINE}` }}>
        {s?.agents.map((a) => {
          const live = a.live[0]
          const [c, state] = STATE[live?.status ?? 'idle'] ?? STATE.idle
          const bad = (a.outcomes.error ?? 0) + (a.outcomes.declined ?? 0)
          const ok = a.actions ? Math.round((100 * (a.actions - bad)) / a.actions) : null
          return (
            <div key={a.key} onClick={() => nav('/agents')} style={{ ...PANE, padding: '12px 14px', cursor: 'pointer', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontWeight: 800, fontSize: 14.5 }}>{a.label}</span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: MUT }}><span style={dot(c)} />{state}</span>
                <span style={{ marginLeft: 'auto', fontSize: 11.5, color: DIM, whiteSpace: 'nowrap' }}>{ago(a.last)}</span>
              </div>
              <div style={{ display: 'flex', gap: 16, margin: '10px 0' }}>
                {([['Chats', a.conversations], ['Actions', num(a.actions)], ['OK', ok == null ? '—' : `${ok}%`]] as [string, React.ReactNode][]).map(([k, v]) => (
                  <div key={k}>
                    <div style={{ fontSize: 11, color: DIM, fontWeight: 600 }}>{k}</div>
                    <div style={{ fontSize: 15, fontWeight: 800 }}>{v}</div>
                  </div>
                ))}
              </div>
              <Week daily={a.daily} days={s.days} />
            </div>
          )
        })}
      </div>

      <div style={{ borderTop: `1px solid ${LINE}` }}>
        <div style={{ padding: '10px 18px 4px', fontSize: 12.5, fontWeight: 800, color: MUT }}>Conversations</div>
        {!s?.recent.length && <div style={{ ...line, color: DIM }}>{s ? 'None yet' : 'Loading…'}</div>}
        {s?.recent.slice(0, 5).map((r) => (
          <div key={r.agent + r.id} style={line} title={r.title}>
            <span style={{ ...ell, fontWeight: 600 }}>{r.title || 'Untitled'}</span>
            <span style={right}>{label(r.agent)} · {r.user} · {ago(r.updated)}</span>
          </div>
        ))}
      </div>
    </Box>
  )
}

function Machines({ h }: { h: { primary: Host; hosts: Host[]; trains_ml?: string } | null }) {
  const nav = useNavigate()
  const all = h ? [h.primary, ...h.hosts] : []
  const up = all.filter((m) => m.primary || m.test?.ssh).length
  return (
    <Box title="Machines" to="/servers" extra={h && <Chip tone={up === all.length ? 'ok' : 'warn'}>{up}/{all.length} reachable</Chip>}>
      {!h && <div style={{ ...line, color: DIM }}>Loading…</div>}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12, padding: h ? 14 : 0, borderTop: h ? `1px solid ${LINE}` : 'none' }}>
        {all.map((m) => {
          const sp = m.specs || {}
          const ok = m.primary || m.test?.ssh
          const gpu = sp.gpus?.length ? sp.gpus.join(', ') : 'none'
          const rows: [string, string][] = [
            ['CPU', (sp.cpu || '—').replace(/\(R\)|\(TM\)|CPU|@.*$/g, '').replace(/\s+/g, ' ').trim()],
            ['Cores', sp.cores ? `${sp.cores}${sp.isolated ? ` · isolated ${sp.isolated}` : ''}` : '—'],
            ['Memory', sp.mem_gb ? `${sp.mem_gb} GB${sp.hugepages_gb ? ` · ${sp.hugepages_gb} GB huge` : ''}` : '—'],
            ['GPU', sp.gpu_use?.length ? `${gpu} · ${sp.gpu_use.join(', ')}` : gpu],
            ['Disk free', sp.disk_free_gb != null ? `${sp.disk_free_gb} GB` : '—'],
            ['Running', sp.stacks?.length ? sp.stacks.join(', ') : 'nothing'],
          ]
          return (
            <div key={m.id} onClick={() => nav('/servers')} style={{ ...PANE, padding: 14, cursor: 'pointer', minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={dot(ok ? TEAL : BAD)} title={ok ? 'reachable' : 'unreachable'} />
                <span style={{ fontWeight: 800, fontSize: 15, ...ell }}>{m.nickname}</span>
                {m.primary && <Chip tone="brand">primary</Chip>}
                {h?.trains_ml === m.id && <Chip tone="ok">trains ML</Chip>}
                <span style={{ marginLeft: 'auto', fontSize: 12, color: ok ? MUT : BAD, whiteSpace: 'nowrap' }}>
                  {ok ? (m.primary ? 'this server' : `${m.test?.ping_ms?.toFixed(1)} ms`) : 'unreachable'}
                </span>
              </div>
              <div style={{ fontSize: 12, color: DIM, fontFamily: font.label, margin: '2px 0 10px 16px' }}>
                {m.user}@{m.address}{m.port && m.port !== 22 ? `:${m.port}` : ''}
              </div>
              {rows.map(([k, v]) => (
                <div key={k} style={{ display: 'flex', gap: 10, fontSize: 12.5, padding: '2px 0' }}>
                  <span style={{ width: 70, color: DIM, flex: '0 0 70px' }}>{k}</span>
                  <span style={{ ...ell, color: k === 'Running' && v !== 'nothing' ? TEAL : INK, fontWeight: k === 'Running' && v !== 'nothing' ? 700 : 500 }} title={v}>{v}</span>
                </div>
              ))}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 10 }}>
                <Chip tone={sp.dpdk ? 'ok' : 'mut'}>DPDK{sp.dpdk ? ` ${sp.dpdk}` : ''}</Chip>
                <Chip tone={sp.ptp ? 'ok' : 'mut'}>PTP</Chip>
                <Chip tone={sp.gpus?.length ? 'ok' : 'mut'}>GPU</Chip>
                <Chip tone={sp.docker ? 'ok' : 'mut'}>Docker</Chip>
                <Chip tone={m.test?.sudo ? 'ok' : 'mut'}>sudo</Chip>
                {!m.primary && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: DIM }}>tested {ago(m.test?.at)}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </Box>
  )
}

function ModelsData() {
  const models = usePoll<{ models: Model[] }>('/api/lake/models', 60000)
  const lake = usePoll<{ stacks: LakeStack[] }>('/api/lake/overview', 60000)
  const bench = usePoll<{ benchmarks: Bench[] }>('/api/lake/benchmarks', 60000)
  const ml = (models?.models ?? []).filter((m) => m.stack)
  const stacks = [...new Set(ml.map((m) => m.stack as string))]
  const [modes, setModes] = useState<Record<string, MlState>>({})
  useEffect(() => {
    if (!stacks.length) return
    let on = true
    Promise.all(stacks.map((s) => get<MlState>(`/api/deploy/stacks/${s}/ml`).then((r) => [s, r] as const).catch(() => null)))
      .then((xs) => on && setModes(Object.fromEntries(xs.filter(Boolean) as [string, MlState][])))
    return () => { on = false }
  }, [stacks.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  const all = lake?.stacks ?? []
  const rows = all.reduce((a, s) => a + s.rows, 0), csvs = all.reduce((a, s) => a + s.csvs, 0), size = all.reduce((a, s) => a + s.bytes, 0)
  const trained = ml.filter((m) => m.source === 'trained' && m.exists).length
  const latestBench = (s: string) => (bench?.benchmarks ?? []).filter((b) => b.stack === s).sort((a, b) => b.t - a.t)[0]
  const cols = 'minmax(96px, 1.3fr) 92px minmax(80px, 1fr) minmax(70px, .8fr) 72px'
  const head: React.CSSProperties = { fontSize: 11.5, color: DIM, fontWeight: 700 }

  return (
    <Box title="Models and data" to="/studio">
      <TileRow cols={90}>
        <Tile k="Rows" v={num(rows)} />
        <Tile k="CSVs" v={csvs} />
        <Tile k="Size" v={bytes(size)} />
        <Tile k="Trained" v={`${trained}/${stacks.length}`} />
      </TileRow>
      <div style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, padding: '10px 18px 6px', borderTop: `1px solid ${LINE}` }}>
        <span style={head}>Stack</span><span style={head}>Mode</span><span style={head}>Model</span><span style={head}>Data</span><span style={head}>Baseline</span>
      </div>
      {stacks.map((s) => {
        const m = ml.find((x) => x.stack === s && x.source === 'trained') ?? ml.find((x) => x.stack === s)!
        const d = all.find((x) => x.stack === s)
        const st = modes[s]
        const f = st?.features?.[0]
        const mode = st?.lifecycle.mode
        const b = latestBench(s)
        const mine = b?.results.find((r) => r.model)
        const best = b?.results.filter((r) => !r.model).sort((x, y) => (b.lower_is_better ? x.value - y.value : y.value - x.value))[0]
        const wins = mine && best ? (b!.lower_is_better ? mine.value < best.value : mine.value > best.value) : null
        const isTrained = m.exists && m.source === 'trained'
        return (
          <div key={s} style={{ display: 'grid', gridTemplateColumns: cols, gap: 10, alignItems: 'center', padding: '9px 18px',
            borderTop: `1px solid ${LINE}`, fontSize: 13 }}>
            <span style={{ fontWeight: 800, ...ell }} title={f ? `${f.label} · ${f.algo}` : m.feature}>{s}</span>
            <span>{mode ? <Chip tone={mode === 'closed-loop' ? 'brand' : mode === 'shadow' ? 'ok' : 'mut'}>{mode}</Chip> : '—'}</span>
            <span style={{ ...ell, color: isTrained ? INK : WARN }} title={isTrained ? `${m.name} · ${bytes(m.bytes)}` : 'the DU uses its compiled-in seed'}>
              {isTrained ? `trained ${ago(m.mtime)}` : 'seed only'}</span>
            <span style={{ ...ell, color: MUT }} title={d ? `${d.csvs} CSVs · ${d.runs} runs · ${bytes(d.bytes)} · collected ${ago(d.last)}` : ''}>
              {num(d?.rows ?? 0)} rows</span>
            <span title={b && mine && best ? `${b.metric} ${mine.value.toFixed(3)} vs ${best.value.toFixed(3)} ${b.unit} (${best.name})` : 'not benchmarked'}>
              {wins == null ? <span style={{ color: DIM }}>—</span> : <Chip tone={wins ? 'ok' : 'bad'}>{wins ? 'beats' : 'below'}</Chip>}
            </span>
          </div>
        )
      })}
      {models && !stacks.length && <div style={{ ...line, color: DIM }}>No models</div>}
    </Box>
  )
}

export function ScreenHome() {
  const nav = useNavigate()
  const summary = usePoll<Summary>('/api/agents/summary', 10000)
  const hosts = usePoll<{ primary: Host; hosts: Host[]; trains_ml?: string }>('/api/hosts', 60000)
  const runs = usePoll<{ runs: Run[] }>('/api/lake/runs?limit=6', 15000)
  const scenes = usePoll<Scene[] | { scenes?: Scene[] }>('/api/map/scenes', 60000)

  const sceneList: Scene[] = Array.isArray(scenes) ? scenes : scenes?.scenes ?? []
  const touched = (s: Scene) => Math.max(s.snapshot_at || 0, s.coverage_at || 0, s.traced_at || 0, s.built_at || 0)
  const scene = [...sceneList].sort((a, b) => touched(b) - touched(a))[0]
  const cover = scene?.coverage_stats?.total_cells ? Math.round((100 * (scene.coverage_stats.covered_cells ?? 0)) / scene.coverage_stats.total_cells) : null

  return (
    <div style={{ color: INK, position: 'relative' }}>
      <div style={{ position: 'relative', height: 320 }}>
        <div style={{ position: 'absolute', top: 18, left: 34, right: 34, display: 'flex', alignItems: 'center', gap: 11, minHeight: 50 }}>
          <div style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-1px', color: '#0B1E26', marginRight: 'auto' }}>Open AI-RAN Testbed</div>
          <button className="sk-btn-primary" onClick={() => nav('/builder?new=1')}>
            <Icon.plus size={17} stroke="#fff" /> New scenario
          </button>
          <UserChip />
        </div>
      </div>

      <div style={{ position: 'relative', zIndex: 1, padding: '0 34px 34px', marginTop: -46, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(300px, 1fr)', gap: 16, alignItems: 'stretch' }}>
          <Agents s={summary} />
          <div style={{ position: 'relative', minWidth: 0, minHeight: 320 }}>
          <Box title="Latest scene" to="/scenes" style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
            {!scene && <div style={{ ...line, color: DIM }}>{scenes ? 'No scenes yet' : 'Loading…'}</div>}
            {scene && (
              <div style={{ cursor: 'pointer', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }} onClick={() => nav(`/builder?scene=${encodeURIComponent(scene.scene_id)}`)}>
                <div style={{ flex: 1, minHeight: 0, background: '#EEF3F4' }}><Thumb id={scene.scene_id} /></div>
                <div style={{ padding: '10px 18px 14px' }}>
                  <div style={{ fontWeight: 800, fontSize: 14.5 }}>{scene.name || scene.city || 'Untitled scene'}</div>
                  <div style={{ fontSize: 12.5, color: MUT, marginTop: 2 }}>
                    {[scene.size_m && `${Math.round(scene.size_m[0])}×${Math.round(scene.size_m[1])} m`,
                      scene.traced_at ? 'ray-traced' : 'not traced',
                      cover != null && `${cover}% covered`, ago(touched(scene))].filter(Boolean).join(' · ')}
                  </div>
                </div>
              </div>
            )}
          </Box>
          </div>
        </div>

        <Machines h={hosts} />

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 420px), 1fr))', gap: 16, alignItems: 'start' }}>
          <ModelsData />
          <Box title="Recent runs" to="/runs">
            {!runs?.runs.length && <div style={{ ...line, color: DIM }}>{runs ? 'No runs yet' : 'Loading…'}</div>}
            {runs?.runs.map((r) => (
              <div key={r.stack + r.id} style={line}>
                <span style={dot(r.outcome === 'running' ? TEAL : r.outcome === 'failed' ? BAD : '#B9C7CC')} />
                <span style={{ fontWeight: 700, ...ell }}>{r.stack}</span>
                <span style={{ color: MUT }}>{r.outcome}</span>
                <span style={right}>{r.rows ? `${num(r.rows)} rows · ` : ''}{ago(r.started)}</span>
              </div>
            ))}
          </Box>
        </div>
      </div>
    </div>
  )
}
