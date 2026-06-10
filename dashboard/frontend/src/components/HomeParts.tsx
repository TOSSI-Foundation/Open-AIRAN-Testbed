import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authHeader } from '../lib/auth'

const T = {
  ink: '#0E1820', mut: '#5B6E77', dim: '#93A5AC', bd: '#E2E9EA',
  brand: '#327985', good: '#0A7A4A', warn: '#A56C08', bad: '#B3272C',
}

type Tone = 'good' | 'warn' | 'bad' | 'idle'
const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  good: { fg: '#0A7A4A', bg: '#E8F6EF', bd: '#BFE3D2' },
  warn: { fg: '#8A5B0B', bg: '#FFF6E5', bd: '#F0DCB4' },
  bad: { fg: '#B3272C', bg: '#FDECEA', bd: '#F3C9C6' },
  idle: { fg: '#5B6E77', bg: '#F1F5F6', bd: '#E2E9EA' },
}

export function Pip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  const t = TONE[tone]
  return (
    <span style={{ border: `1px solid ${t.bd}`, background: t.bg, color: t.fg, borderRadius: 7,
                   padding: '2px 8px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
      {children}
    </span>
  )
}

export function ago(t?: number | null): string | null {
  if (!t) return null
  const s = Date.now() / 1000 - t
  if (s < 90) return 'just now'
  if (s < 5400) return `${Math.round(s / 60)}m ago`
  if (s < 172800) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function dur(s?: number): string | null {
  if (s == null) return null
  if (s < 90) return `${Math.round(s)}s`
  if (s < 5400) return `${Math.round(s / 60)}m`
  return `${(s / 3600).toFixed(1)}h`
}

function usePoll<T>(url: string, ms = 10000): { data: T | null; err: boolean } {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let live = true
    const pull = () => {
      fetch(url, { headers: { ...authHeader() } })
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((d) => { if (live) { setData(d); setErr(false) } })
        .catch(() => { if (live) setErr(true) })
    }
    pull()
    const iv = window.setInterval(pull, ms)
    return () => { live = false; window.clearInterval(iv) }
  }, [url, ms])
  return { data, err }
}

function Panel({ title, right, children, onClick }: {
  title: string; right?: React.ReactNode; children: React.ReactNode; onClick?: () => void
}) {
  return (
    <div style={{ background: 'rgba(255,255,255,.66)', border: '1px solid rgba(255,255,255,.72)',
                  borderRadius: 14, overflow: 'hidden', display: 'flex',
                  flexDirection: 'column' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 16px 0' }}>
        <span style={{ font: '10px ui-monospace, monospace', letterSpacing: '.1em',
                       textTransform: 'uppercase', color: T.mut }}>{title}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {right}
          {onClick && (
            <span onClick={onClick} style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700,
                                             color: T.brand }}>Open ›</span>
          )}
        </span>
      </div>
      <div style={{ flex: 1 }}>{children}</div>
    </div>
  )
}

type Stage = { key: string; label: string; ok: boolean; detail?: string | null }

export function StackStrip() {
  const nav = useNavigate()
  const { data, err } = usePoll<{ stages?: Stage[] }>('/api/ran/status', 8000)
  const stages = data?.stages || []
  const up = stages.filter((s) => s.ok).length
  const why = stages.find((s) => !s.ok && s.detail)?.detail

  return (
    <Panel title="Stack"
           right={err ? <Pip tone="bad">unreachable</Pip>
                  : stages.length ? <Pip tone={up === stages.length ? 'good' : up ? 'warn' : 'idle'}>
                      {up} of {stages.length} up
                    </Pip> : null}
           onClick={() => nav('/simulation')}>
      <div style={{ display: 'flex', gap: 8, padding: '12px 16px 14px', flexWrap: 'wrap' }}>
        {(stages.length ? stages : Array.from({ length: 6 }, () => null)).map((s, i) => (
          <div key={s?.key || i}
               style={{ flex: '1 1 120px', minWidth: 110, borderRadius: 10, padding: '9px 11px',
                        background: s == null ? 'rgba(255,255,255,.4)'
                                   : s.ok ? TONE.good.bg : TONE.idle.bg,
                        border: `1px solid ${s == null ? T.bd : s.ok ? TONE.good.bd : T.bd}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', flex: 'none',
                             background: s == null ? '#C3CFD4' : s.ok ? TONE.good.fg : '#C3CFD4' }} />
              <span style={{ fontSize: 12.5, fontWeight: 700,
                             color: s?.ok ? TONE.good.fg : T.mut }}>
                {s?.label || '—'}
              </span>
            </div>
          </div>
        ))}
      </div>
      {why && (
        <div style={{ padding: '0 16px 13px', fontSize: 12, color: T.mut, lineHeight: 1.5 }}>
          {why}
        </div>
      )}
    </Panel>
  )
}

export type Scene = {
  scene_id: string; name?: string | null; state?: string; city?: string | null
  nof_gnb?: number; nof_ue?: number; nof_buildings?: number
  size_m?: [number, number] | null
  has_coverage?: boolean
  built_at?: number | null; traced_at?: number | null
  coverage_at?: number | null; snapshot_at?: number | null
  coverage_stats?: {
    total_cells?: number; covered_cells?: number; median_db?: number
    coverage?: { rss?: { fraction_of_served?: number }
                 sinr?: { fraction_of_served?: number } }
  }
}

export function Thumb({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    let made: string | null = null
    fetch(`/api/map/scenes/${id}/thumb`, { headers: authHeader() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!live || !b) return
        made = URL.createObjectURL(b)
        setUrl(made)
      })
      .catch(() => {})
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [id])
  if (!url) return null
  return <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover',
                                        display: 'block' }} />
}

export function SceneGallery() {
  const nav = useNavigate()
  const { data, err } = usePoll<Scene[] | { scenes?: Scene[] }>('/api/map/scenes', 30000)
  const all: Scene[] = Array.isArray(data) ? data : (data?.scenes || [])
  const traced = all.filter((s) => s.traced_at).length
  const SHOWN = 4
  const touched = (s: Scene) =>
    Math.max(s.snapshot_at || 0, s.coverage_at || 0, s.traced_at || 0, s.built_at || 0)
  const scenes = [...all].sort((a, b) => touched(b) - touched(a)).slice(0, SHOWN)
  const rest = all.length - scenes.length

  const pct = (s: Scene): number | null => {
    const tot = s.coverage_stats?.total_cells, c = s.coverage_stats?.covered_cells
    return tot && c != null ? Math.round((100 * c) / tot) : null
  }

  const title = (s: Scene): string =>
    s.name || s.city || `scene ${s.scene_id.slice(9, 15)}`

  const area = (s: Scene): string | null => {
    const d = s.size_m
    if (!d || d.length < 2) return null
    return `${Math.round(d[0])}×${Math.round(d[1])} m`
  }

  return (
    <Panel title="Scenes"
           right={err ? <Pip tone="bad">unreachable</Pip>
                  : all.length
                    ? <span style={{ fontSize: 12, color: T.dim, fontWeight: 600 }}>
                        {rest > 0 ? `${scenes.length} of ${all.length}` : `${all.length}`}
                        {' built · '}{traced} ray-traced
                      </span>
                    : null}
           onClick={() => nav('/scenes')}>
      {!err && all.length === 0 && (
        <div style={{ padding: '18px 16px', fontSize: 13, color: T.dim }}>
          {data == null ? 'Loading…' : 'No scenes built yet.'}
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                    gap: 14, padding: '12px 16px 16px' }}>
        {scenes.map((s) => {
          const p = pct(s)
          const med = s.coverage_stats?.median_db
          const steps: [string, boolean][] = [
            ['built', !!s.built_at],
            ['traced', !!s.traced_at],
            ['coverage', !!s.coverage_at],
            ['snapshot', !!s.snapshot_at],
          ]
          const done = steps.filter(([, ok]) => ok).length
          return (
            <div key={s.scene_id}
                 onClick={() => nav(`/builder?scene=${encodeURIComponent(s.scene_id)}`)}
                 style={{ cursor: 'pointer', borderRadius: 12, overflow: 'hidden',
                          background: '#fff', border: '1px solid ' + T.bd,
                          display: 'flex', flexDirection: 'column' }}>
              <div style={{ position: 'relative', height: 168, background: '#DDE7EA' }}>
                <Thumb id={s.scene_id} />
                {p != null && (
                  <span style={{ position: 'absolute', top: 8, right: 8,
                                 background: 'rgba(255,255,255,.94)', borderRadius: 7,
                                 padding: '3px 8px', fontSize: 11, fontWeight: 800,
                                 color: p >= 60 ? TONE.good.fg : p >= 25 ? TONE.warn.fg : T.mut }}>
                    {p}% cells served
                  </span>
                )}
                {!s.traced_at && (
                  <span style={{ position: 'absolute', top: 8, left: 8,
                                 background: 'rgba(255,255,255,.94)', borderRadius: 7,
                                 padding: '3px 8px', fontSize: 10.5, fontWeight: 700,
                                 color: TONE.warn.fg }}>
                    not traced
                  </span>
                )}
              </div>
              <div style={{ padding: '10px 12px 11px', display: 'flex', flexDirection: 'column',
                            gap: 5, flex: 1 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: T.ink,
                              whiteSpace: 'nowrap', overflow: 'hidden',
                              textOverflow: 'ellipsis' }}>
                  {title(s)}
                </div>
                <div style={{ font: '11px ui-monospace, monospace', color: T.dim,
                              whiteSpace: 'nowrap', overflow: 'hidden',
                              textOverflow: 'ellipsis' }}>
                  {[s.city, area(s)].filter(Boolean).join(' · ') || '—'}
                </div>
                <div style={{ font: '11px ui-monospace, monospace', color: T.mut }}>
                  {s.nof_gnb ?? '–'} gNB · {s.nof_ue ?? '–'} UE
                  {' · '}{s.nof_buildings ?? '–'} bldg
                  {med != null && (
                    <span style={{ color: T.dim }}>{' · '}{Math.round(med)} dB</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 'auto',
                              paddingTop: 6 }}>
                  {steps.map(([label, ok]) => (
                    <span key={label} title={label}
                          style={{ flex: 1, height: 3, borderRadius: 2,
                                   background: ok ? TONE.good.fg : T.bd,
                                   opacity: ok ? .75 : 1 }} />
                  ))}
                  <span style={{ font: '10px ui-monospace, monospace', color: T.dim,
                                 flex: 'none' }}>
                    {done}/4
                  </span>
                </div>
              </div>
            </div>
          )
        })}
      </div>
      {rest > 0 && (
        <div onClick={() => nav('/scenes')}
             style={{ padding: '0 16px 15px', fontSize: 12.5, fontWeight: 700,
                      color: T.brand, cursor: 'pointer' }}>
          {rest} more {rest === 1 ? 'scene' : 'scenes'} in the library ›
        </div>
      )}
    </Panel>
  )
}

function Rows({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <div style={{ padding: '11px 16px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
      {rows.map(([k, v], i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12, fontSize: 12.5 }}>
          <span style={{ color: T.dim, fontWeight: 600 }}>{k}</span>
          <span style={{ marginLeft: 'auto', color: T.ink, fontWeight: 700,
                         fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{v}</span>
        </div>
      ))}
    </div>
  )
}

type Ho = {
  ue_running?: boolean
  gnb1?: { running?: boolean; amf?: boolean; xn?: boolean; pci?: number | null; wedged?: boolean }
  gnb2?: { running?: boolean; amf?: boolean; xn?: boolean; pci?: number | null; wedged?: boolean }
}

export function HandoverPanel() {
  const nav = useNavigate()
  const { data, err } = usePoll<Ho>('/api/ran/ho/status', 8000)
  const g1 = data?.gnb1, g2 = data?.gnb2
  const live = (g?: Ho['gnb1']) => !!g?.running
  const ready = live(g1) && live(g2) && !!g1?.xn && !!g2?.xn
  const wedged = !!g1?.wedged || !!g2?.wedged

  const cell = (g?: Ho['gnb1'], n = 1) => (
    <span style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
      {live(g) ? <Pip tone={g?.xn ? 'good' : 'warn'}>{g?.xn ? 'Xn up' : 'no Xn'}</Pip>
               : <Pip tone="idle">down</Pip>}
      {g?.pci != null && (
        <span style={{ font: '11px ui-monospace, monospace', color: T.dim }}>PCI {g.pci}</span>
      )}
    </span>
  )

  return (
    <Panel title="Handover"
           right={err ? <Pip tone="bad">unreachable</Pip>
                  : wedged ? <Pip tone="bad">wedged</Pip>
                  : ready ? <Pip tone="good">ready</Pip> : <Pip tone="idle">idle</Pip>}
           onClick={() => nav('/simulation/handover')}>
      <Rows rows={[
        ['Source gNB', cell(g1, 1)],
        ['Target gNB', cell(g2, 2)],
        ['UE', data?.ue_running ? <Pip tone="good">running</Pip> : <Pip tone="idle">down</Pip>],
      ]} />
    </Panel>
  )
}

export function TracePanel({ scenes }: { scenes?: Scene[] }) {
  const nav = useNavigate()
  const { data, err } = usePoll<{ available?: boolean }>('/api/map/health', 30000)
  const { data: jobs } = usePoll<unknown[]>('/api/map/jobs', 8000)
  const queue = Array.isArray(jobs) ? jobs.length : 0
  const list = scenes || []
  const traced = list.filter((s) => s.traced_at)
  const newest = traced.sort((a, b) => (b.traced_at || 0) - (a.traced_at || 0))[0]

  return (
    <Panel title="Ray trace"
           right={err ? <Pip tone="bad">unreachable</Pip>
                  : queue ? <Pip tone="warn">{queue} queued</Pip>
                  : data?.available ? <Pip tone="good">ready</Pip> : <Pip tone="idle">offline</Pip>}
           onClick={() => nav('/scenes')}>
      <Rows rows={[
        ['Scenes traced', `${traced.length} of ${list.length}`],
        ['Last trace', newest ? (newest.name || 'untitled') : '—'],
        ['When', ago(newest?.traced_at) || '—'],
      ]} />
    </Panel>
  )
}
