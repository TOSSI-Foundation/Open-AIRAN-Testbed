import { UserChip } from '../components/TopBar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getToken, authHeader } from '../lib/auth'
import { useSearchParams } from 'react-router-dom'
import {
  mapApi, pollJob, isError, fmtDb, fmtWhen, GROUND_MATERIALS, GROUND_MATERIAL_LABELS,
  type MapHealth, type SceneMeta, type Job, type LiveStatus, type TraceResult,
  type CoverageOverlay, type DuConfig,
  type CoverageStats, type CoverageBand, type ChannelExport, type SceneSeal, type RouteTrace,
} from '../lib/mapApi'
import {
  T, S, Section, Group, FieldLabel, Actions, Readout, SelectField,
  Hint, Empty, Tag, Dot, Banner, Caret,
} from './panelKit'

const MAP_URL = `/sionna-map/index.html?v=${Date.now()}&draft=1`
const LAST_SCENE_KEY = 'tossi.twin.lastScene'

type Pkg = { manifest: any; buildings: any }

interface MapNode {
  id: string
  name: string
  type: 'gnb' | 'tower' | 'ue'
  lonlat: [number, number]
  heightAGL: number
  on: string
  hasRoute: boolean
  rf: { freq_hz: number; tx_power_dbm: number; azimuth_deg: number; downtilt_deg: number; cols: number } | null
}

interface MapModel { id: string; model: string; scale: number; rotation_deg: number; material: string }

interface DesignState {
  hasArea: boolean
  areaSizeM: [number, number] | null
  nodes: { gnb: number; tower: number; ue: number }
  nodeList: MapNode[]
  models: MapModel[]
  pendingModel: string | null
  hasRoute: boolean
  edits: number
  addedBuildings: number
  mode: string | null
  rf: { freq_hz: number; cols: number; tx_power_dbm: number }
  city: string
  view: MapView
  buildingOpacity: number
}

const MAP_VIEWS = ['roadmap', 'satellite', 'hybrid', 'terrain'] as const
type MapView = (typeof MAP_VIEWS)[number]

const EMPTY_DESIGN: DesignState = {
  hasArea: false, areaSizeM: null, nodes: { gnb: 0, tower: 0, ue: 0 }, nodeList: [], models: [],
  pendingModel: null, hasRoute: false, edits: 0, addedBuildings: 0, mode: null,
  rf: { freq_hz: 3.48942e9, cols: 4, tx_power_dbm: 43 }, city: '', view: 'roadmap',
  buildingOpacity: 0.96,
}

function coverageBand(st?: CoverageStats): CoverageBand | null {
  const c = st?.coverage
  if (!c) return null
  return c.rss ?? c.sinr ?? null
}

function coverageLabel(b: CoverageBand): string {
  return `${(b.fraction_of_area * 100).toFixed(1)}% of area \u2265 ${b.threshold_db} ${b.unit}`
}

function exportWhen(created?: number): string {
  if (!created) return 'unknown time'
  const age = Date.now() / 1000 - created
  if (age < 60) return `${Math.max(0, Math.round(age))}s ago`
  if (age < 3600) return `${Math.floor(age / 60)} min ago`
  if (age < 86400) return `${Math.floor(age / 3600)} hr ago`
  return new Date(created * 1000).toLocaleDateString()
}

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const onlyChannels = (r?: ChannelExport[]) => (r ?? []).filter((e) => e.kind !== 'bundle')

const onlyBundles = (r?: ChannelExport[]) => (r ?? []).filter((e) => e.kind === 'bundle')

type LinkKpi = {
  tx: string; rx: string
  tx_power_dbm?: number; num_tx_ant?: number; num_rx_ant?: number; num_paths?: number
  path_gain_db?: number
  snr_db?: { mrt: number; uniform_beam: number }
  sinr_db?: { mrt: number; uniform_beam: number } | null
  noise_figure_db?: number
  noise_dbm_per_subcarrier?: number
  interference_dbm_per_subcarrier?: number | null
  interferers?: number
  effective_rank?: number; max_rank?: number
  bandwidth_hz?: number
  subcarrier_spacing_hz?: number
  spectral_efficiency_bps_hz?: { mrt: number; uniform_beam: number; no_csi: number }
  throughput_mbps?: { mrt: number; uniform_beam: number; no_csi: number }
  rms_delay_spread_s?: number
  beamforming_gain_db?: number; array_gain_ceiling_db?: number
}

function KpiBar({ label, value, unit, frac, tone, note }: {
  label: string; value: string; unit?: string; frac: number
  tone?: 'ok' | 'warn' | 'dead'; note?: string
}) {
  const fill = tone === 'dead' ? T.dim : tone === 'warn' ? '#E0A030' : T.brand
  const pct = Math.max(0, Math.min(1, Number.isFinite(frac) ? frac : 0)) * 100
  return (
    <div style={{ marginTop: 7 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                    gap: 8, fontSize: 11.5 }}>
        <span style={{ color: T.mut, fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 800, color: tone === 'dead' ? T.dim : T.ink }}
          className="sk-mono">
          {value}{unit ? <span style={{ color: T.mut, fontWeight: 600 }}> {unit}</span> : null}
        </span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: T.fill, marginTop: 3,
                    overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: fill,
                      transition: 'width .2s ease' }} />
      </div>
      {note && <div style={{ fontSize: 10.5, color: T.mut, marginTop: 2 }}>{note}</div>}
    </div>
  )
}

async function downloadAuthed(url: string, name: string): Promise<string> {
  let res: Response
  try {
    res = await fetch(url, { headers: { ...authHeader() } })
  } catch {
    return 'could not reach the server'
  }
  if (res.status === 401) return 'session expired — sign in again'
  if (!res.ok) return `download failed (HTTP ${res.status})`
  const blob = await res.blob()
  const obj = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = obj
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(obj), 0)
  return ''
}

function DlLink({ url, name, children }: {
  url: string; name: string; children: React.ReactNode
}) {
  const [err, setErr] = useState('')
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 1 }}>
      <button type="button" className="sk-link-btn"
        onClick={async () => setErr(await downloadAuthed(url, name))}
        style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit',
                 color: T.brand, fontWeight: 700, textAlign: 'left' }}>
        {children}
      </button>
      {err && <span style={{ fontSize: 10.5, fontWeight: 600, color: '#B42318' }}>{err}</span>}
    </span>
  )
}

function RouteWalk({ sceneId, version, canTrace, busy, onTrace, post, originLonLat, onLeave }: {
  sceneId: string; version: number; canTrace: boolean; busy: boolean
  onTrace: () => void; post: (m: Record<string, unknown>) => void
  originLonLat: number[] | null; onLeave: () => void
}) {
  const [rt, setRt] = useState<RouteTrace | null>(null)
  const [k, setK] = useState(0)
  const [on, setOn] = useState(false)
  const [playing, setPlaying] = useState(false)
  const prevK = useRef(-1)
  useEffect(() => {
    let live = true
    setRt(null); setK(0); setOn(false); setPlaying(false)
    mapApi.routeTrace(sceneId).then((r) => { if (live && !isError(r) && r.route) setRt(r) }).catch(() => {})
    return () => { live = false }
  }, [sceneId, version])
  const n = rt?.route.points.length ?? 0
  const here = rt ? rt.matrix.filter((m) => m.ue === `${rt.route.ue}@${k}`) : []
  const best = here.find((m) => m.best) ?? here[0]
  useEffect(() => {
    if (!on || !rt) return
    const paths = here.flatMap((m) => (m.path_detail ?? []).map((p) => ({ ...p, tx: m.tx })))
    if (k < prevK.current) post({ type: 'sk-live-ue', enu: null })
    prevK.current = k
    post({ type: 'sk-load-rays', paths, origin_lonlat: originLonLat })
    post({ type: 'sk-live-ue', enu: rt.route.points[k], trail: 1000, gain_db: best?.gain_db })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, rt, k])
  useEffect(() => {
    if (!playing) return
    const t = setInterval(() => setK((v) => (v + 1 < n ? v + 1 : (setPlaying(false), v))), 700)
    return () => clearInterval(t)
  }, [playing, n])
  const leave = () => { setOn(false); setPlaying(false); prevK.current = -1; post({ type: 'sk-live-ue', enu: null }); onLeave() }
  useEffect(() => () => { if (on) post({ type: 'sk-live-ue', enu: null }) }, [on, post])

  return (
    <div style={{ marginTop: S.md }}>
      <Actions>
        <button className="sk-btn-ghost" disabled={busy || !canTrace} onClick={onTrace}
          style={{ flex: '1 1 0', justifyContent: 'center', padding: '8px 0', fontSize: 12.5 }}
          title={canTrace ? undefined : 'No UE route'}>
          {rt ? 'Re-trace route' : 'Trace route'}
        </button>
        {rt && (
          <button className="sk-btn-ghost" style={{ flex: '0 0 auto', padding: '8px 14px', fontSize: 12.5 }}
            onClick={() => { if (!on) setOn(true); if (k >= n - 1) setK(0); setPlaying(!playing) }}>
            {playing ? 'Pause' : 'Play'}
          </button>
        )}
        {rt && on && (
          <button className="sk-btn-ghost" style={{ flex: '0 0 auto', padding: '8px 12px', fontSize: 12.5 }} onClick={leave}>
            Done
          </button>
        )}
      </Actions>
      {rt && (
        <>
          <input type="range" min={0} max={Math.max(0, n - 1)} value={k} aria-label="Position along the route"
            onChange={(e) => { setOn(true); setPlaying(false); setK(Number(e.target.value)) }}
            style={{ width: '100%', marginTop: S.sm, accentColor: T.brand }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, color: T.mut, fontWeight: 700 }}
            className="sk-mono">
            <span>{k + 1}/{n} · {rt.route.s_m[k]} m</span>
            <span style={{ color: T.ink }}>
              {best ? `${best.tx} ${fmtDb(best.gain_db)}${best.los ? ' · LOS' : ''}` : '—'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function LinkKpis({ sceneId, saved, savedOf, savedNf, tracedAt }: {
  sceneId: string
  saved?: LinkKpi[] | null
  savedOf?: number | null
  savedNf?: number | null
  tracedAt?: number | null
}) {
  const [rows, setRows] = useState<LinkKpi[] | null>(saved ?? null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  useEffect(() => { setRows(saved ?? null); setErr('') }, [sceneId, saved])
  const stale = !!rows?.length && savedOf != null && tracedAt != null && savedOf !== tracedAt
  const [nf, setNf] = useState(savedNf ?? 7)
  useEffect(() => { if (savedNf != null) setNf(savedNf) }, [savedNf])

  async function solve() {
    setBusy(true); setErr(''); setRows(null)
    const r = await mapApi.linkKpi(sceneId, { noise_figure_db: nf })
    setBusy(false)
    if (isError(r)) { setErr(r.error); return }
    const got = (r.result?.kpis ?? r.kpis ?? []) as LinkKpi[]
    if (!got.length) { setErr('the solve returned no links'); return }
    setRows(got)
  }

  function downloadCsv() {
    if (!rows?.length) return
    const r3 = (v: number | null | undefined) =>
      v == null || !Number.isFinite(v) ? '' : Math.round(v * 1000) / 1000
    const live = (k: LinkKpi) => (k.path_gain_db ?? 0) > -299
    const n3 = (k: LinkKpi, v: number | null | undefined) => (live(k) ? r3(v) : '')

    const cols: [string, (k: LinkKpi) => string | number][] = [
      ['scene_id', () => sceneId],
      ['tx', (k) => k.tx ?? ''],
      ['rx', (k) => k.rx ?? ''],
      ['usable', (k) => (live(k) ? 'yes' : 'no')],
      ['throughput_mrt_mbps', (k) => n3(k, k.throughput_mbps?.mrt)],
      ['throughput_uniform_mbps', (k) => n3(k, k.throughput_mbps?.uniform_beam)],
      ['throughput_no_csi_mbps', (k) => n3(k, k.throughput_mbps?.no_csi)],
      ['snr_mrt_db', (k) => n3(k, k.snr_db?.mrt)],
      ['sinr_mrt_db', (k) => n3(k, k.sinr_db?.mrt)],
      ['interference_dbm_per_subcarrier', (k) => n3(k, k.interference_dbm_per_subcarrier)],
      ['noise_dbm_per_subcarrier', (k) => r3(k.noise_dbm_per_subcarrier)],
      ['noise_figure_db', (k) => r3(k.noise_figure_db)],
      ['path_gain_db', (k) => n3(k, k.path_gain_db)],
      ['effective_rank', (k) => n3(k, k.effective_rank)],
      ['max_rank', (k) => k.max_rank ?? ''],
      ['array_gain_db', (k) => n3(k, k.beamforming_gain_db)],
      ['array_gain_ceiling_db', (k) => r3(k.array_gain_ceiling_db)],
      ['rms_delay_spread_s', (k) => (live(k) ? (k.rms_delay_spread_s ?? '') : '')],
      ['num_paths', (k) => k.num_paths ?? ''],
      ['bandwidth_hz', (k) => k.bandwidth_hz ?? ''],
      ['subcarrier_spacing_hz', (k) => k.subcarrier_spacing_hz ?? ''],
    ]
    const esc = (v: string | number) => {
      const s = String(v)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }
    const csv = [cols.map((c) => c[0]).join(',')]
      .concat(rows.map((k) => cols.map((c) => esc(c[1](k))).join(',')))
      .join('\n')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `linkkpi_${sceneId}_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const dB = (v?: number, p = 1) => (v == null ? '—' : `${v.toFixed(p)} dB`)

  return (
    <div style={{ marginTop: S.md }}>
        <div style={{ display: 'flex', gap: S.sm, alignItems: 'flex-end' }}>
          <div style={{ flex: '0 0 130px' }}>
            <NumField label="Noise figure" unit="dB" value={nf} onChange={setNf}
            min={1} max={30} step={0.5} />
          </div>
        </div>
        <Actions>
            <button className="sk-btn-primary" disabled={busy} onClick={() => void solve()} style={{ flex: '0 0 auto', padding: '9px 16px', fontSize: 13, borderRadius: 9 }}>
            {busy ? 'Solving…' : 'Compute'}
            </button>
            {!!rows?.length && (
            <button className="sk-btn-ghost" onClick={downloadCsv}
            style={{ flex: '0 0 auto', padding: '9px 14px', fontSize: 13, borderRadius: 9 }}>
            Download
            </button>
            )}
        </Actions>
        {err && <Hint tone="warn">{err}</Hint>}
        {!rows && !err && !busy && (
          <Hint>Not computed</Hint>
        )}
        {stale && (
          <Hint tone="warn">Stale · re-compute</Hint>
        )}
        {rows?.map((k) => {
          const thr = k.throughput_mbps?.mrt
          const bw = k.bandwidth_hz ? k.bandwidth_hz / 1e6 : null
          const peak = Math.max(1, ...(rows ?? []).map((r) => r.throughput_mbps?.mrt ?? 0))
          const dead = (k.path_gain_db ?? 0) <= -299 || (thr ?? 0) <= 0
          const snr = k.sinr_db ? k.sinr_db.mrt : k.snr_db?.mrt
          return (
            <div key={`${k.tx}->${k.rx}`}
              style={{ marginTop: S.sm, paddingTop: S.sm, borderTop: `1px solid ${T.bd}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 800 }}>{k.rx} ← {k.tx}</span>
                {dead && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: T.dim }}>
                    no link
                  </span>
                )}
              </div>

              {!dead && (
                <>
                  <KpiBar label="Throughput" value={(thr ?? 0).toFixed(1)} unit="Mbps"
                    frac={(thr ?? 0) / peak} tone="ok"
                    note={`${(k.throughput_mbps?.uniform_beam ?? 0).toFixed(0)}–`
                      + `${(thr ?? 0).toFixed(0)} Mbps`
                      + (bw ? ` · ${bw.toFixed(2)} MHz` : '')} />
                  <KpiBar label={k.sinr_db ? 'SINR' : 'SNR'} value={(snr ?? 0).toFixed(1)} unit="dB"
                    frac={((snr ?? 0) + 10) / 50}
                    tone={(snr ?? 0) < 0 ? 'warn' : 'ok'} />
                  {k.beamforming_gain_db != null && (
                    <KpiBar label="Array gain" value={k.beamforming_gain_db.toFixed(2)} unit="dB"
                      frac={k.beamforming_gain_db / Math.max(k.array_gain_ceiling_db ?? 1, 0.01)}
                      note={`max ${(k.array_gain_ceiling_db ?? 0).toFixed(2)} dB`} />
                  )}
                </>
              )}
              {!dead && (
                <div style={{ marginTop: S.sm, paddingTop: S.sm,
                              borderTop: `1px solid ${T.bd}` }}>
                {k.sinr_db && (
                  <Readout label="Interference" mono tone="warn"
                    value={`${(k.interference_dbm_per_subcarrier ?? 0).toFixed(1)} dBm · `
                      + `${k.interferers} other cell${k.interferers === 1 ? '' : 's'}`} />
                )}
                <Readout label="Noise floor" mono
                  value={`${(k.noise_dbm_per_subcarrier ?? 0).toFixed(1)} dBm at NF `
                    + `${k.noise_figure_db ?? nf} dB`} />
                <Readout label="Path gain" mono value={dB(k.path_gain_db)} />
                <Readout label="Rank"
                  value={`${(k.effective_rank ?? 0).toFixed(2)} of ${k.max_rank ?? '—'}`} />
                <Readout label="Delay spread" mono
                  value={k.rms_delay_spread_s == null ? '—'
                    : `${(k.rms_delay_spread_s * 1e9).toFixed(2)} ns`} />
                <Readout label="Paths" value={String(k.num_paths ?? '—')} />
                </div>
              )}
            </div>
          )
        })}
    </div>
  )
}

function ChannelExports({ sceneId, onCount }: {
  sceneId: string
  onCount?: (n: number) => void
}) {
  const [rows, setRows] = useState<ChannelExport[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const [tracedAt, setTracedAt] = useState<number | null>(null)

  const load = useCallback(async () => {
    const r = await mapApi.channelExports(sceneId)
    if (isError(r)) { setErr(r.error); setRows([]); return }
    setErr('')
    setTracedAt((r as { traced_at?: number }).traced_at ?? null)
    const mine = onlyChannels(r.exports)
    setRows(mine)
    onCount?.(mine.length)
  }, [sceneId, onCount])

  useEffect(() => { void load() }, [load])

  async function removeOne(name: string) {
    const r = await mapApi.deleteChannelExport(name)
    if (isError(r)) { setErr(r.error || `could not delete ${name}`); return }
    setRows((prev) => {
      const next = (prev ?? []).filter((x) => x.name !== name)
      onCount?.(next.length)
      return next
    })
  }

  async function makeOne() {
    setBusy(true); setErr('')
    const r = await mapApi.channelExport(sceneId)
    if (isError(r)) { setErr(r.error); setBusy(false); return }
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 1500))
      const l = await mapApi.channelExports(sceneId)
      if (isError(l)) continue
      const mine = onlyChannels(l.exports)
      if (mine.length !== (rows ?? []).length) {
        setRows(mine); onCount?.(mine.length); break
      }
    }
    setBusy(false)
  }

  return (
    <div style={{ marginTop: S.md }}>
        <Actions>
          <button className="sk-btn-primary" style={{ padding: '9px 16px', fontSize: 13, borderRadius: 9 }} disabled={busy} onClick={() => void makeOne()}>
            {busy ? 'Exporting…' : 'Export channel'}
          </button>
        </Actions>
        {err && <Hint tone="warn">{err}</Hint>}
        {err ? null
          : rows == null ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No exports</Empty>
          : rows.slice(0, 8).map((e) => (
            <div key={e.name} title={e.name}
              style={{ padding: '7px 0', borderTop: `1px solid ${T.bd}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 800 }}>{exportWhen(e.created)}</span>
                {e.direction && (
                  <span style={{ fontSize: 10.5, fontWeight: 600, color: T.mut }}>
                    {e.direction}
                  </span>
                )}
                {tracedAt != null && e.created < tracedAt && (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: '#8A5B0B' }}>
                    stale
                  </span>
                )}
                <button onClick={() => void removeOne(e.name)} title={`Delete ${e.name}`}
                  aria-label="Delete this export"
                  style={{ marginLeft: 'auto', width: 22, height: 22, borderRadius: 6, color: T.mut, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                           background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                  onMouseOver={(ev) => { ev.currentTarget.style.color = T.bad }}
                  onMouseOut={(ev) => { ev.currentTarget.style.color = T.mut }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none"
                    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 4.5h10" /><path d="M6.5 4.5V3.2h3v1.3" />
                    <path d="M4.4 4.5 5 13h6l.6-8.5" /><path d="M6.8 6.8v3.9M9.2 6.8v3.9" />
                  </svg>
                </button>
              </div>
              <div style={{ display: 'flex', gap: 14, marginTop: 3, alignItems: 'baseline',
                            fontSize: 12 }}>
                <DlLink url={e.download} name={e.name}>
                  tensors <span style={{ color: T.mut, fontWeight: 600 }}>{fmtBytes(e.bytes)}</span>
                </DlLink>
                {e.paths ? (
                  <DlLink url={e.paths} name={e.paths.split('/').pop() || 'paths.csv'}>
                    paths CSV{' '}
                    <span style={{ color: T.mut, fontWeight: 600 }}>
                      {fmtBytes(e.paths_bytes ?? 0)}
                    </span>
                  </DlLink>
                ) : (
                  <span style={{ color: T.mut, fontWeight: 600 }}>no paths CSV</span>
                )}
              </div>
            </div>
          ))}
        {rows && rows.length > 8 && (
          <Hint>8 of {rows.length}</Hint>
        )}
    </div>
  )
}

const SEAL_PART: Record<string, string> = {
  meshes_sha256: 'the buildings',
  package_sha256: 'the design',
  scene_xml_sha256: 'the scene XML',
}

function SceneSealState({ sceneId }: { sceneId: string }) {
  const [seal, setSeal] = useState<SceneSeal | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await mapApi.sceneSeal(sceneId)
    setSeal(isError(r) ? null : r)
  }, [sceneId])

  useEffect(() => { void load() }, [load])

  async function reseal() {
    setBusy(true)
    const r = await mapApi.sealScene(sceneId)
    setBusy(false)
    if (!isError(r)) await load()
  }

  if (!seal) return null

  if (seal.sealed && seal.matches) return null

  const changed = (seal.changed ?? []).map((k) => SEAL_PART[k] ?? k)
  const known = seal.sealed
  return (
    <div style={{ marginTop: S.sm, padding: '8px 10px', borderRadius: 8,
                  border: `1px solid ${known ? T.bad : T.bd}`,
                  background: known ? T.fill : 'transparent' }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: known ? T.bad : T.mut }}>
        {known
          ? `Changed since ${seal.sealed_at_iso?.slice(0, 10) ?? 'it was sealed'}`
          : 'Not sealed'}
      </div>
      {known && (
        <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 600, marginTop: 2 }}>
          Changed: {changed.join(', ')}
        </div>
      )}
      <button className="sk-btn-ghost" disabled={busy} onClick={() => void reseal()}
        style={{ marginTop: 6, fontSize: 11, fontWeight: 700, padding: '4px 9px' }}>
        {busy ? 'Sealing…' : known ? 'Re-seal' : 'Seal'}
      </button>
    </div>
  )
}

function BundleGains({ e }: { e: ChannelExport }) {
  const gains = Object.entries(e.link_gain_db ?? {})
  if (!gains.length) {
    return (
      <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 600, marginTop: 2 }}>
        no traced link
      </div>
    )
  }
  return (
    <div style={{ marginTop: 2 }}>
      {gains.slice(0, 3).map(([rx, g]) => {
        const n = e.link_paths?.[rx]
        return (
          <div key={rx} style={{ fontSize: 11.5, color: T.mut, fontWeight: 600 }}>
            <span style={{ color: T.ink, fontWeight: 700 }}>{rx}</span>{' '}
            <span style={{ color: T.ink, fontWeight: 700 }}>{g.toFixed(2)} dB</span>
            {n != null && ` · ${n} path${n === 1 ? '' : 's'}`}
          </div>
        )
      })}
      {gains.length > 3 && (
        <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 600 }}>
          +{gains.length - 3}
        </div>
      )}
    </div>
  )
}

function SceneBundles({ sceneId }: { sceneId: string }) {
  const [rows, setRows] = useState<ChannelExport[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const load = useCallback(async () => {
    const r = await mapApi.channelExports(sceneId)
    if (isError(r)) { setErr(r.error); return }
    setErr('')
    setRows(onlyBundles(r.exports))
  }, [sceneId])

  useEffect(() => { void load() }, [load])

  async function build() {
    setBusy(true); setErr('')
    const r = await mapApi.sceneBundle(sceneId)
    setBusy(false)
    if (isError(r)) { setErr(r.error); return }
    await load()
  }

  async function removeOne(name: string) {
    const r = await mapApi.deleteChannelExport(name)
    if (isError(r)) { setErr(r.error || `could not delete ${name}`); return }
    setRows((prev) => (prev ?? []).filter((x) => x.name !== name))
  }

  return (
    <div style={{ marginTop: S.md }}>
        <Actions>
          <button className="sk-btn-primary" style={{ padding: '9px 16px', fontSize: 13, borderRadius: 9 }} disabled={busy || !sceneId} onClick={() => void build()}>
            {busy ? 'Packaging…' : 'Build bundle'}
          </button>
        </Actions>
        {err && <Hint tone="warn">{err}</Hint>}
        {rows == null ? <Empty>Loading…</Empty>
          : rows.length === 0 ? <Empty>No bundles</Empty>
          : rows.slice(0, 5).map((e) => (
            <div key={e.name} title={e.name}
              style={{ padding: '7px 0', borderTop: `1px solid ${T.bd}` }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 800 }}>{exportWhen(e.created)}</span>
                {e.nof_meshes != null && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: T.mut }}>
                    {e.nof_meshes} meshes
                  </span>
                )}
                <button onClick={() => void removeOne(e.name)} title={`Delete ${e.name}`}
                  aria-label="Delete this bundle"
                  style={{ marginLeft: 'auto', width: 22, height: 22, borderRadius: 6, color: T.mut, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                           background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px' }}
                  onMouseOver={(ev) => { ev.currentTarget.style.color = T.bad }}
                  onMouseOut={(ev) => { ev.currentTarget.style.color = T.mut }}>
                  <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none"
                    stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 4.5h10" /><path d="M6.5 4.5V3.2h3v1.3" />
                    <path d="M4.4 4.5 5 13h6l.6-8.5" /><path d="M6.8 6.8v3.9M9.2 6.8v3.9" />
                  </svg>
                </button>
              </div>
              <div style={{ marginTop: 2, fontSize: 12 }}>
                <DlLink url={e.download} name={e.name}>
                  bundle <span style={{ color: T.mut, fontWeight: 600 }}>{fmtBytes(e.bytes)}</span>
                </DlLink>
              </div>
              <BundleGains e={e} />
            </div>
          ))}
        {rows && rows.length > 5 && <Hint>5 of {rows.length}</Hint>}
    </div>
  )
}

function RayKey({ c, label }: { c: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 14, height: 3, borderRadius: 2, background: c, flex: '0 0 auto' }} />
      <span>{label}</span>
    </div>
  )
}

export function ScreenTwin() {
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const pkgWaiters = useRef(new Map<number, (p: Pkg) => void>())
  const reqId = useRef(0)
  const restoredRef = useRef<string | null>(null)
  const explicitRef = useRef<string | null>(null)
  const refreshModelsRef = useRef<(() => void) | null>(null)

  const [health, setHealth] = useState<MapHealth | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const [design, setDesign] = useState<DesignState>(EMPTY_DESIGN)

  const [scenes, setScenes] = useState<SceneMeta[]>([])
  const [sceneId, setSceneId] = useState<string | null>(() => localStorage.getItem(LAST_SCENE_KEY))
  const [job, setJob] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatusRaw] = useState('Ready')
  const [statusBad, setStatusBad] = useState(false)
  const setStatus = useCallback((t: string) => { setStatusRaw(t); setStatusBad(false) }, [])
  const failStatus = useCallback((t: string) => { setStatusRaw(t); setStatusBad(true) }, [])
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [coverageOn, setCoverageOn] = useState(false)
  const [panelFolded, setPanelFolded] = useState(true)
  const panelW = panelFolded ? PANEL_HANDLE_W : PANEL_W
  const [live, setLive] = useState<LiveStatus | null>(null)
  const [showConsole, setShowConsole] = useState(false)

  const areaLabel = design.areaSizeM
    ? `${Math.round(design.areaSizeM[0])} × ${Math.round(design.areaSizeM[1])} m`
    : 'map view'

  const [mapModal, setMapModal] = useState(false)

  const [sceneNames, setSceneNames] = useState<Record<string, string>>({})
  const [cfg, setCfg] = useState<{ path: string; name: string } | null>(null)
  const [ask, setAsk] = useState<{ kind: 'save' | 'delete'; sceneId?: string } | null>(null)
  const [nameEdit, setNameEdit] = useState<string | null>(null)

  const [sio, setSio] = useState<Record<string, unknown> | null>(null)
  const [sioAdv, setSioAdv] = useState(false)

  useEffect(() => {
    if (!sceneId) { setSio(null); return }
    let live = true
    mapApi.sceneSionna(sceneId).then((r) => (isError(r) ? null : r))
      .then((d) => { if (live && d?.params) setSio(d.params) }).catch(() => {})
    return () => { live = false }
  }, [sceneId])

  const setSionna = useCallback(async (patch: Record<string, unknown>) => {
    if (!sceneId) return
    const prev = sio
    setSio((cur) => (cur ? { ...cur, ...patch } : cur))
    const d = await mapApi.setSceneSionna(sceneId, patch)
    if (isError(d)) { setSio(prev); setError(d.error || 'Could not save that setting.'); return }
    if ((d as any)?.params) setSio((d as any).params)
  }, [sceneId])

  const [ue, setUe] = useState<Record<string, unknown> | null>(null)
  const [ueEff, setUeEff] = useState<Record<string, unknown> | null>(null)
  const [ueAdv, setUeAdv] = useState(false)

  useEffect(() => {
    if (!sceneId) { setUe(null); setUeEff(null); return }
    let live = true
    mapApi.sceneUe(sceneId).then((r) => (isError(r) ? null : r))
      .then((d) => { if (live && d?.params) { setUe(d.params); setUeEff(d.effective ?? null) } })
      .catch(() => {})
    return () => { live = false }
  }, [sceneId])

  const setUeParam = useCallback(async (patch: Record<string, unknown>) => {
    if (!sceneId) return
    const prev = ue
    setUe((cur) => (cur ? { ...cur, ...patch } : cur))
    const d = await mapApi.setSceneUe(sceneId, patch)
    if (isError(d)) { setUe(prev); setError(d.error || 'Could not save that setting.'); return }
    if (d?.params) { setUe(d.params); setUeEff(d.effective ?? null) }
  }, [sceneId, ue])

  const [step, setStep] = useState<string>('')
  const [group, setGroup] = useState<string>('')
  const [nExports, setNExports] = useState<number | null>(null)
  const [raysOn, setRaysOn] = useState(true)
  const [rayBand, setRayBand] = useState<'all' | 'direct' | 'strong' | 'weak'>('all')
  const [rayTx, setRayTx] = useState('')
  const openStep = (k: string) => setStep((cur) => (cur === k ? '' : k))
  const openGroup = (k: string) => setGroup((cur) => {
    if (cur === k) { setStep(''); return '' }
    return k
  })

  const [duConfigs, setDuConfigs] = useState<DuConfig[]>([])
  const [duPath, setDuPath] = useState('')

  const [minArea, setMinArea] = useState(8)
  const [ground, setGround] = useState<string>('very_dry_ground')
  const [terrain, setTerrain] = useState(true)
  const [fetchOverture, setFetchOverture] = useState(true)
  const [vegetation, setVegetation] = useState(true)
  const [srate, setSrate] = useState(61.44)
  const [txSelect, setTxSelect] = useState('')
  const [samples, setSamples] = useState(300000)
  const [cellSize, setCellSize] = useState(5)
  const [covDepth, setCovDepth] = useState(3)
  const [vmin, setVmin] = useState(-140)
  const [vmax, setVmax] = useState(-60)

  const scene = useMemo(() => scenes.find((s) => s.scene_id === sceneId) ?? null, [scenes, sceneId])

  useEffect(() => {
    let live = true
    Promise.all(scenes.slice(0, 24).map((s) =>
      mapApi.sceneConfig(s.scene_id).then((r) => (isError(r) ? null : r))
        .then((c) => [s.scene_id, c?.name ?? null] as const)
        .catch(() => [s.scene_id, null] as const)))
      .then((pairs) => {
        if (!live) return
        const m: Record<string, string> = {}
        pairs.forEach(([id, n]) => { if (n) m[id] = n })
        setSceneNames(m)
      })
    return () => { live = false }
  }, [scenes])

  async function openNodeConfig(nodeId: string) {
    if (!sceneId) return
    try {
      const d: any = await mapApi.setSceneGnbConfig(sceneId, { node_id: nodeId, base: duPath || undefined })
      if (isError(d) || !d?.ok) {
        setError((isError(d) && d.error) || d?.error || 'Could not open that config.'); return
      }
      setCfg({ path: d.path, name: `${nodeId} · ${d.name}` })
      if (d.created) setStatus(`Made ${d.name} for ${nodeId} from ${d.copied_from.split('/').pop()}.`)
    } catch { setError('Backend unreachable') }
  }
  const trace: TraceResult | null = (scene?.trace as TraceResult) ?? null
  const du = useMemo(() => duConfigs.find((d) => d.path === duPath) ?? null, [duConfigs, duPath])

  useEffect(() => {
    if (sceneId && duPath) {
      void mapApi.setSceneConfig(sceneId, { du_config: duPath }).then((r) => {
        if (isError(r)) setError(r.error || 'Could not attach the DU config to this scene.')
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, duPath])
  const transmitters = design.nodeList.filter((n) => n.type === 'gnb' || n.type === 'tower')

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin)
  }, [])

  useEffect(() => {
    post({ type: 'sk-inset', right: panelW + PANEL_INSET * 2 })
  }, [panelW, post])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      const d = e.data || {}
      switch (d.type) {
        case 'sk-ready':
          if (d.restored) {
            restoredRef.current = d.restoredScene ?? '__draft__'
            if (d.restoredScene && !explicitRef.current) setSceneId(String(d.restoredScene))
          }
          setMapReady(true)
          post({ type: 'sk-inset', right: panelW + PANEL_INSET * 2 })
          post({ type: 'sk-auth', token: getToken() ?? '' })
          break
        case 'sk-modal': setMapModal(!!d.open); break
        case 'sk-models-changed': refreshModelsRef.current?.(); break
        case 'sk-state': setDesign({ ...EMPTY_DESIGN, ...d }); break
        case 'sk-package': {
          const resolve = pkgWaiters.current.get(d.requestId)
          if (resolve) { pkgWaiters.current.delete(d.requestId); resolve(d.package as Pkg) }
          break
        }
        case 'sk-error': setError(String(d.error)); break
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const getPackage = useCallback(
    (timeoutMs = 8000) =>
      new Promise<Pkg>((resolve, reject) => {
        if (!mapReady) { reject(new Error('Map loading')); return }
        const id = ++reqId.current
        pkgWaiters.current.set(id, resolve)
        post({ type: 'sk-request-package', requestId: id })
        setTimeout(() => { if (pkgWaiters.current.delete(id)) reject(new Error('the map did not respond')) }, timeoutMs)
      }),
    [mapReady, post],
  )

  const refreshScenes = useCallback(async () => {
    const s = await mapApi.scenes()
    if (!isError(s)) setScenes(s)
  }, [])

  const refreshModels = useCallback(async () => {
    const m = await mapApi.models()
    if (!isError(m)) {
      post({ type: 'sk-models', models: m.map((x) => x.name) })
    }
  }, [post])

  useEffect(() => {
    mapApi.health().then((h) => !isError(h) && setHealth(h))
    mapApi.duConfigs().then((d) => {
      if (isError(d)) return
      setDuConfigs(d)
      const pick = d.find((x) => x.sionna_driver) ?? d[0]
      if (pick) setDuPath(pick.path)
    })
    refreshScenes()
    mapApi.liveStatus().then((l) => !isError(l) && setLive(l))
  }, [refreshScenes])

  useEffect(() => { if (mapReady) refreshModels() }, [mapReady, refreshModels])
  useEffect(() => { refreshModelsRef.current = refreshModels }, [refreshModels])

  useEffect(() => {
    if (!live?.running) return
    const t = setInterval(async () => {
      const l = await mapApi.liveStatus()
      if (!isError(l)) setLive(l)
    }, 1500)
    return () => clearInterval(t)
  }, [live?.running])

  useEffect(() => { if (sceneId) localStorage.setItem(LAST_SCENE_KEY, sceneId) }, [sceneId])

  const runJob = useCallback(
    async (start: Promise<any>, onDone: (j: Job) => void | Promise<void>) => {
      setBusy(true); setError(null); setNotes([])
      try {
        const started = await start
        if (isError(started)) { setError(started.error); failStatus('Refused'); return }
        setShowConsole(true)
        const final = await pollJob(started.job_id, setJob)
        if (isError(final)) { setError(final.error); return }
        if (final.state === 'cancelled') { setStatus('Cancelled.'); return }
        if (final.state === 'failed') { setError(final.error || 'the stage failed — see the console'); failStatus('Failed.'); return }
        await onDone(final)
      } finally { setBusy(false) }
    }, [])

  function onNewScene() {
    const unbuilt = !sceneId && (design.hasArea || design.nodes.gnb + design.nodes.tower + design.nodes.ue > 0)
    if (unbuilt && !window.confirm(
      'Discard unbuilt scene?')) return
    post({ type: 'sk-clear' })
    post({ type: 'sk-hide-coverage' })
    post({ type: 'sk-hide-rays' })
    setRaysOn(false)
    restoredRef.current = null
    setSceneId(null)
    localStorage.removeItem(LAST_SCENE_KEY)
    setCoverageOn(false)
    setError(null)
    setGroup('design')
    setStep('design')
    setStatus('New scene')
  }

  async function onBuild() {
    setStatus('Reading the scene from the map…')
    let pkg: Pkg
    try { pkg = await getPackage() } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      failStatus('Could not read map')
      return
    }
    const n = pkg?.buildings?.features?.length ?? 0
    setStatus(fetchOverture ? 'Fetching footprints from Overture…' : `Building a Sionna scene from ${n} buildings…`)
    await runJob(
      mapApi.build(pkg, { min_area: minArea, ground_material: ground, terrain, fetch_overture: fetchOverture,
                          vegetation }),
      async (j) => {
        const id = j.result?.scene_id ?? j.scene_id
        restoredRef.current = id
        setSceneId(id); setCoverageOn(false)
        await refreshScenes()
        setStatus(`Scene built — ${j.result?.buildings_extruded ?? n} buildings, ${j.result?.nof_meshes ?? '?'} meshes.`)
      })
  }

  const savedRays = useMemo(
    () => ((trace?.matrix ?? trace?.links ?? []) as Array<{ tx?: string; path_detail?: TraceResult['links'][0]['path_detail'] }>)
      .flatMap((l) => (l.path_detail ?? []).map((p) => ({ ...p, tx: l.tx })))
      .filter((p) => (p.points ?? []).length > 1),
    [trace])

  useEffect(() => {
    if (!mapReady || !savedRays.length) return
    post({ type: 'sk-load-rays', paths: savedRays, origin_lonlat: scene?.origin_lonlat ?? null })
    post({ type: 'sk-ray-band', band: rayBand })
    post({ type: 'sk-ray-tx', tx: rayTx })
    setRaysOn(true)
  }, [mapReady, savedRays, scene?.origin_lonlat])

  function toggleRays() {
    if (raysOn) { post({ type: 'sk-hide-rays' }); setRaysOn(false); return }
    if (savedRays.length) {
      post({ type: 'sk-load-rays', paths: savedRays, origin_lonlat: scene?.origin_lonlat ?? null })
      post({ type: 'sk-ray-band', band: rayBand })
      post({ type: 'sk-ray-tx', tx: rayTx })
    }
    post({ type: 'sk-show-rays' })
    setRaysOn(true)
  }

  function chooseRayTx(tx: string) {
    setRayTx(tx)
    post({ type: 'sk-ray-tx', tx })
  }

  function chooseBand(b: 'all' | 'direct' | 'strong' | 'weak') {
    setRayBand(b)
    post({ type: 'sk-ray-band', band: b })
  }

  async function onTrace() {
    if (!sceneId) return
    setStatus('Ray tracing the link budget…')
    await runJob(
      mapApi.trace(sceneId, {
        max_depth: Number(sio?.max_depth) || 5, tx: txSelect || undefined,
        ...(du ? { du_config: du.path } : { srate: srate * 1e6 }),
      }),
      async (j) => {
        await refreshScenes()
        const links = (j.result?.links ?? []) as TraceResult['links']
        const drawFrom = (j.result?.matrix ?? links) as Array<{ tx?: string; path_detail?: TraceResult['links'][0]['path_detail'] }>
        const rays = drawFrom.flatMap((l) => (l.path_detail ?? []).map((p) => ({ ...p, tx: l.tx })))
          .filter((p) => (p.points ?? []).length > 1)
        if (rays.length) {
          post({ type: 'sk-load-rays', paths: rays, origin_lonlat: scene?.origin_lonlat ?? null })
          post({ type: 'sk-ray-band', band: rayBand })
          post({ type: 'sk-ray-tx', tx: rayTx })
          setRaysOn(true)
        }
        const totalPaths = links.reduce((n, l) => n + (l.paths ?? 0), 0)
        const drawnShare = rays.reduce((a, p) => a + (p.share ?? 0), 0)
        const rayNote = !rays.length ? '.'
          : totalPaths > rays.length
            ? `, drew the ${rays.length} strongest of ${totalPaths} paths `
              + `(${(drawnShare * 100).toFixed(1)}% of the energy).`
            : `, drew ${rays.length} ray path(s).`
        setStatus(links.length ? `Traced ${links.length} link(s)${rayNote}` : 'Traced.')
      })
  }

  const captureSceneSnapshot = useCallback((id: string) => {
    const reqId = Date.now()
    let done = false
    const onFrame = (e: MessageEvent) => {
      const d = e.data || {}
      if (e.origin !== window.location.origin || d.type !== 'sk-frame' || d.requestId !== reqId) return
      done = true
      window.removeEventListener('message', onFrame)
      if (d.image) void mapApi.sceneSnapshot(id, d.image)
    }
    window.addEventListener('message', onFrame)
    post({ type: 'sk-capture', requestId: reqId, quality: 0.8, frame: true })
    setTimeout(() => { if (!done) window.removeEventListener('message', onFrame) }, 4000)
  }, [post])

  const [routeVersion, setRouteVersion] = useState(0)
  async function onRouteTrace() {
    if (!sceneId) return
    setStatus('Ray tracing every position along the route…')
    await runJob(
      mapApi.trace(sceneId, {
        max_depth: Number(sio?.max_depth) || 5, route_step_m: 25,
        ...(du ? { du_config: du.path } : { srate: srate * 1e6 }),
      }),
      async (j) => {
        setRouteVersion((v) => v + 1)
        setStatus(`Route traced — ${j.result?.positions ?? '?'} positions.`)
      })
  }

  async function onCoverage() {
    if (!sceneId) return
    setStatus(`Solving the radio map (${samples.toLocaleString()} samples/tx)…`)
    await runJob(
      mapApi.coverage(sceneId, { samples, cell_size: cellSize, max_depth: covDepth, vmin, vmax }),
      async (j) => {
        const overlay = j.result?.overlay as CoverageOverlay | undefined
        if (overlay) {
          post({ type: 'sk-load-coverage', overlay })
          setCoverageOn(true)
          setTimeout(() => captureSceneSnapshot(sceneId), 400)
        }
        await refreshScenes()
        const st = j.result?.stats
        setStatus(st ? `Reached: ${st.covered_cells}/${st.total_cells} cells, ${Math.round(st.gain_db_min)}…${Math.round(st.gain_db_max)} dB.` : 'Coverage computed.')
      })
  }

  async function toggleCoverage() {
    if (!sceneId) return
    if (coverageOn) { post({ type: 'sk-hide-coverage' }); setCoverageOn(false); return }
    const c = await mapApi.sceneCoverage(sceneId)
    if (isError(c)) { setError('No coverage'); return }
    post({ type: 'sk-load-coverage', overlay: c.overlay }); setCoverageOn(true)
  }

  const openScene = useCallback(
    async (id: string, opts: { silent?: boolean } = {}) => {
      restoredRef.current = id
      setError(null); setSceneId(id)
      const pkg = await mapApi.scenePackage(id)
      if (isError(pkg)) {
        if (opts.silent) { localStorage.removeItem(LAST_SCENE_KEY); setSceneId(null) } else setError(pkg.error)
        return
      }
      post({ type: 'sk-load-manifest', manifest: pkg.manifest ?? pkg, sceneId: id })
      setStatus(`Opened ${id}`)
      const c = await mapApi.sceneCoverage(id)
      if (!isError(c)) {
        post({ type: 'sk-load-coverage', overlay: c.overlay })
        setCoverageOn(true)
      } else {
        post({ type: 'sk-hide-coverage' })
        setCoverageOn(false)
      }
    }, [post])

  useEffect(() => {
    if (!mapReady || !sceneId || restoredRef.current === sceneId) return
    openScene(sceneId, { silent: true })
  }, [mapReady, sceneId, openScene])

  const coverageForRestored = useRef<string | null>(null)
  useEffect(() => {
    if (!mapReady || !sceneId) return
    if (restoredRef.current !== sceneId) return
    if (coverageForRestored.current === sceneId) return
    coverageForRestored.current = sceneId
    let live = true
    void (async () => {
      const c = await mapApi.sceneCoverage(sceneId)
      if (!live || isError(c)) return
      post({ type: 'sk-load-coverage', overlay: c.overlay })
      setCoverageOn(true)
    })()
    return () => { live = false }
  }, [mapReady, sceneId, post])

  const [params, setParams] = useSearchParams()

  const newRef = useRef(false)
  useEffect(() => {
    if (!params.get('new') || newRef.current) return
    newRef.current = true
    setParams({}, { replace: true })
    explicitRef.current = '__new__'
  }, [params, setParams])

  useEffect(() => {
    if (!mapReady || explicitRef.current !== '__new__') return
    explicitRef.current = null
    onNewScene()
  }, [mapReady])

  useEffect(() => {
    const want = params.get('scene')
    if (!want) return
    explicitRef.current = want
    setParams({}, { replace: true })
    if (restoredRef.current !== want) restoredRef.current = null
    setSceneId(want)
  }, [params, setParams])

  async function removeScene(id: string) {
    const r = await mapApi.deleteScene(id)
    if (isError(r)) { setError(r.error); return }
    if (sceneId === id) { setSceneId(null); localStorage.removeItem(LAST_SCENE_KEY) }
    await refreshScenes()
  }

  function deleteOpenScene() { if (sceneId) setAsk({ kind: 'delete' }) }

  function commitRename() {
    if (!sceneId || nameEdit === null) return
    const next = nameEdit.trim()
    setNameEdit(null)
    if (next && next !== (sceneNames[sceneId] ?? '')) void persistScene(next)
  }

  function saveOpenScene() {
    if (!sceneId) return
    if (nameEdit !== null) { commitRename(); return }
    const existing = (sceneNames[sceneId] ?? '').trim()
    if (existing) { void persistScene(existing); return }
    setAsk({ kind: 'save' })
  }

  async function persistScene(name: string) {
    if (!sceneId) return
    const d = await mapApi.setSceneConfig(sceneId, duPath ? { name, du_config: duPath } : { name })
    if (isError(d)) { setError(d.error || 'Could not save the scene.'); return }
    setSceneNames((m) => ({ ...m, [sceneId]: name }))
    setStatus(`Saved “${name}”.`)
  }

  async function confirmDelete() {
    const target = ask?.sceneId ?? sceneId
    if (!target) return
    setAsk(null)
    await removeScene(target)
    setStatus('Scene deleted.')
  }

  async function confirmSave(name: string) {
    if (!sceneId || !name.trim()) return
    setAsk(null)
    await persistScene(name.trim())
  }

  async function cancelJob() {
    if (job) await mapApi.cancelJob(job.job_id)
  }

  const envDown = health?.available === false
  const nofTx = design.nodes.gnb + design.nodes.tower
  const buildWhy = !mapReady ? 'map loading'
    : envDown ? 'Sionna unavailable'
    : busy ? 'busy' : null
  const traceWhy = !scene?.built ? 'not built' : busy ? 'busy' : null
  const coverageWhy = !scene?.built ? 'not built' : busy ? 'busy' : null

  const ADV_DEFAULTS: Record<string, number | null> = {
    samples_per_src: 1000000, seed: 42, freq_hz: null, rr_depth: -1,
  }
  const advChanged = useMemo(() => {
    if (!sio) return [] as string[]
    return Object.keys(ADV_DEFAULTS).filter((k) => {
      const now = (sio as Record<string, unknown>)[k]
      const def = ADV_DEFAULTS[k]
      if (def === null) return now !== null && now !== undefined && now !== 0
      return now !== undefined && now !== null && Number(now) !== def
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sio])
  const advSummary = useMemo(() => {
    if (!sio) return ''
    const n = Number(sio.samples_per_src) || 1000000
    const samples = n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n.toLocaleString()
    const carrier = sio.freq_hz ? `carrier ${+(Number(sio.freq_hz) / 1e9).toFixed(3)} GHz`
                                : 'carrier from config'
    const rr = Number(sio.rr_depth ?? -1)
    return [`${samples} samples`, `seed ${Number(sio.seed) || 42}`, carrier,
            rr === -1 ? null : `RR ${rr}`].filter(Boolean).join(', ')
  }, [sio])

  const cellGrid = useMemo(() => {
    if (!scene?.size_m || !cellSize) return null
    const w = Math.round(scene.size_m[0]), h = Math.round(scene.size_m[1])
    const cells = Math.round((w / cellSize) * (h / cellSize))
    return { w, h, cells, tooMany: cells > 4_000_000 }
  }, [scene?.size_m, cellSize])

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#EEF3F4', color: '#0E1820' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, rowGap: 10, flexWrap: 'wrap',
                    padding: '13px 22px', flex: '0 0 auto',
                    background: 'linear-gradient(135deg, rgba(255,255,255,.72) 0%, rgba(255,255,255,.56) 45%, rgba(255,255,255,.48) 100%)',
                    backdropFilter: 'blur(14px) saturate(155%)',
                    WebkitBackdropFilter: 'blur(14px) saturate(155%)',
                    borderBottom: '1px solid rgba(226,233,234,.85)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 6px 18px rgba(24,52,66,.06)',
                    position: 'relative', zIndex: 2 }}>

        <span style={{ fontSize: 20, fontWeight: 800, letterSpacing: '-.4px', flex: '0 0 auto' }}>Scenario Builder</span>
        <Rule />
        <span style={{ flex: '0 0 auto', border: '1px solid ' + T.bd, borderRadius: 6,
                       padding: '2px 8px', fontSize: 11, fontWeight: 800, color: T.dim,
                       letterSpacing: '.2px', whiteSpace: 'nowrap' }}>Overture · Sionna RT</span>
        {design.city && <Tag muted>{design.city}</Tag>}
        {sceneId && (nameEdit === null ? (
          <span onDoubleClick={() => setNameEdit(sceneNames[sceneId] ?? '')}
            title="Double-click to rename"
            style={{ flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', gap: 7,
                     background: '#fff', border: '1px solid ' + T.bd, borderRadius: 7,
                     padding: '3px 9px', fontSize: 12, fontWeight: 800,
                     color: sceneNames[sceneId] ? T.ink : T.dim,
                     cursor: 'text', userSelect: 'none', whiteSpace: 'nowrap' }}>
            {sceneNames[sceneId] || 'unnamed'}
            <Pencil />
          </span>
        ) : (
          <input autoFocus value={nameEdit} maxLength={80}
            onChange={(e) => setNameEdit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setNameEdit(null)
            }}
            onBlur={commitRename}
            style={{ flex: '0 0 auto', background: '#fff', border: '1px solid ' + T.brand,
                     boxShadow: '0 0 0 3px rgba(13,122,140,.13)', borderRadius: 7,
                     padding: '3px 8px', fontSize: 12, fontWeight: 800, color: T.ink,
                     fontFamily: 'inherit', width: 182, outline: 'none' }} />
        ))}

        <Status text={status} busy={busy} bad={statusBad} />

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10,
                      rowGap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Dot ok={health?.available === true}
            label={health === null ? 'Sionna…' : health.available ? 'Sionna ready' : 'Sionna DOWN'} />
          {live?.running && <Dot ok pulse label={`live · ${live.updates} updates`} />}
          <Rule />
          <button className="sk-btn-ghost" style={btn(busy)} disabled={busy}
            onClick={onNewScene}>New scene</button>
          <Rule />
          <button className="sk-btn-ghost"
            style={{ ...btn(busy || !sceneId),
                     color: sceneId && !busy ? T.bad : undefined,
                     borderColor: sceneId && !busy ? T.badLine : undefined,
                     background: sceneId && !busy ? 'rgba(179,39,44,.05)' : undefined }}
            disabled={busy || !sceneId}
            title={sceneId ? undefined : 'No scene open'}
            onClick={deleteOpenScene}>Delete scene</button>
          <button className="sk-btn-ghost" style={btn(busy || !sceneId)} disabled={busy || !sceneId}
            title={sceneId ? undefined : 'No scene open'}
            onClick={saveOpenScene}>Save scene</button>
          <UserChip />
        </div>
      </div>

      {envDown && (
        <Banner>
          Sionna unavailable · set <code>TOSSI_SIONNA_PYTHON</code>
        </Banner>
      )}
      {error && <Banner tone="error" onClose={() => setError(null)}>{error}</Banner>}
      {notes.map((n, i) => <Banner key={i} onClose={() => setNotes([])}>{n}</Banner>)}

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <iframe ref={iframeRef} title="sionna-map" src={MAP_URL} allow="geolocation"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }} />
        {showConsole && <JobConsole job={job} onClose={() => setShowConsole(false)}
          onCancel={cancelJob} rightInset={panelW + PANEL_INSET * 2} />}
        {cfg && <ConfigEditor path={cfg.path} name={cfg.name} onClose={() => setCfg(null)} />}
        {ask && (ask.sceneId ?? sceneId) && (() => {
          const target = (ask.sceneId ?? sceneId) as string
          return (
            <AskDialog kind={ask.kind} sceneName={sceneNames[target] || target}
              initial={sceneNames[target] ?? ''} onCancel={() => setAsk(null)}
              onConfirm={(v) => (ask.kind === 'save' ? confirmSave(v) : confirmDelete())} />
          )
        })()}

        <button type="button"
          onClick={() => setPanelFolded((v) => !v)}
          title={panelFolded ? 'Show panel' : 'Hide panel'}
          aria-expanded={!panelFolded}
          style={{ position: 'absolute',
                   right: panelFolded ? PANEL_INSET : panelW + PANEL_INSET,
                   top: HANDLE_TOP,
                   width: 22, height: 54, padding: 0, cursor: 'pointer',
                   display: 'flex', alignItems: 'center', justifyContent: 'center',
                   border: '1px solid ' + T.bd, borderRight: 0,
                   borderRadius: '10px 0 0 10px', background: '#fff', color: T.mut,
                   boxShadow: '-4px 0 10px rgba(14,26,32,.06)',
                   opacity: mapModal ? 0 : 1,
                   pointerEvents: mapModal ? 'none' : 'auto',
                   zIndex: 3 }}>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden
            style={{ transform: panelFolded ? 'rotate(180deg)' : 'none' }}>
            <path d="M7.5 2.5 4 6l3.5 3.5" fill="none" stroke="currentColor"
              strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {!panelFolded && (
        <div style={{ position: 'absolute', top: PANEL_INSET, right: PANEL_INSET,
                      bottom: PANEL_INSET,
                      display: 'flex', flexDirection: 'column',
                      width: panelW, overflowY: 'auto',
                      color: T.ink, borderRadius: 16,
                      opacity: mapModal ? 0 : 1,
                      pointerEvents: mapModal ? 'none' : 'auto',
                      transition: 'opacity .18s ease',
                      background: T.panel,
                      backdropFilter: 'blur(16px) saturate(160%)',
                      WebkitBackdropFilter: 'blur(16px) saturate(160%)',
                      border: '1px solid rgba(255,255,255,.65)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 12px 34px rgba(24,52,66,.18)' }}>
          <GroupFold title="Design" n={2}
            open={group === 'design'} onToggle={() => openGroup('design')}>

            <Section n={1} title="Design" open={step === 'design'} onToggle={() => openStep('design')}
              hint={design.mode ? `placing ${MODE_LABEL[design.mode] ?? design.mode}` : areaLabel}
              summary={nofTx || design.nodes.ue
                ? `${nofTx} tx · ${design.nodes.ue} UE` : 'empty'}>
              <Stats items={[
                { n: design.nodes.gnb, label: 'gNB', color: NODE_COLOR.gnb },
                { n: design.nodes.tower, label: 'tower', color: NODE_COLOR.tower },
                { n: design.nodes.ue, label: 'UE', color: NODE_COLOR.ue },
              ]} />
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: S.xs,
                            margin: `${S.sm}px 0 ${S.xs}px` }}>
                <MiniBtn on={design.mode === 'area'} onClick={() => post({ type: 'sk-set-mode', mode: 'area' })}>Area</MiniBtn>
                <MiniBtn on={design.mode === 'gnb'} dot={NODE_COLOR.gnb}
                  disabled={(design.nodes?.gnb ?? 0) >= 1}
                  title={(design.nodes?.gnb ?? 0) >= 1 ? 'Max 1 gNB' : undefined}
                  onClick={() => post({ type: 'sk-set-mode', mode: 'gnb' })}
                  onPlus={() => post({ type: 'sk-add-node', nodeType: 'gnb' })} plusTitle="Add at centre">gNB</MiniBtn>
                <MiniBtn on={design.mode === 'tower'} dot={NODE_COLOR.tower} onClick={() => post({ type: 'sk-set-mode', mode: 'tower' })}
                  onPlus={() => post({ type: 'sk-add-node', nodeType: 'tower' })} plusTitle="Add at centre">Tower</MiniBtn>
                <MiniBtn on={design.mode === 'ue'} dot={NODE_COLOR.ue} onClick={() => post({ type: 'sk-set-mode', mode: 'ue' })}
                  onPlus={() => post({ type: 'sk-add-node', nodeType: 'ue' })} plusTitle="Add at centre">UE</MiniBtn>
                <MiniBtn on={design.mode === 'route'} dot={ROUTE_COLOR} onClick={() => post({ type: 'sk-set-mode', mode: 'route' })}>Route</MiniBtn>
                <MiniBtn on={design.mode === 'edit'} onClick={() => post({ type: 'sk-set-mode', mode: 'edit' })}>Buildings</MiniBtn>
                <MiniBtn on={design.mode === 'model'} onClick={() => post({ type: 'sk-set-mode', mode: 'model' })}>Model</MiniBtn>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 2 }}>
                <MiniBtn danger onClick={() => post({ type: 'sk-clear' })}>Clear all</MiniBtn>
              </div>

              {design.nodeList.length > 0 && (
                <div style={{ marginTop: S.md }}><FieldLabel>Nodes ({design.nodeList.length})</FieldLabel></div>
              )}
              {design.nodeList.map((n) => (
                <div key={n.id} style={{ border: '1px solid ' + T.bd, borderRadius: 9, padding: '8px 10px', marginTop: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: NODE_COLOR[n.type] }} />
                    <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700 }}>{n.name}</span>
                    <NumInline value={n.heightAGL} suffix="m" title="Height AGL"
                      onChange={(v) => post({ type: 'sk-set-node-height', id: n.id, value: v })} />
                    <button type="button" title="Remove" aria-label={`Remove ${n.name}`}
                      onClick={() => post({ type: 'sk-remove-node', id: n.id })}
                      style={{ cursor: 'pointer', color: T.dim, background: 'none', border: 'none',
                               width: 22, height: 22, borderRadius: 6, padding: 0, flex: '0 0 auto',
                               display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none"
                        stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M3 4.5h10" /><path d="M6.5 4.5V3.2h3v1.3" />
                        <path d="M4.4 4.5 5 13h6l.6-8.5" /><path d="M6.8 6.8v3.9M9.2 6.8v3.9" />
                      </svg>
                    </button>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 3,
                                paddingLeft: 17, fontSize: 11, color: T.dim }}>
                    <span>{n.hasRoute ? 'route' : n.on}</span>
                    {(n.type === 'gnb' || n.type === 'tower') && (
                      <button type="button" onClick={() => openNodeConfig(n.id)}
                        disabled={!sceneId}
                        title={sceneId ? undefined : 'No scene open'}
                        style={{ background: 'none', border: 'none', padding: 0, fontFamily: 'inherit',
                                 fontSize: 11, fontWeight: 700, color: sceneId ? T.brand : T.dim,
                                 cursor: sceneId ? 'pointer' : 'not-allowed',
                                 textDecoration: 'underline', textUnderlineOffset: 2 }}>
                        Edit config
                      </button>
                    )}
                  </div>
                </div>
              ))}

              {(design.edits > 0 || design.addedBuildings > 0) && (
                <div style={{ marginTop: S.sm }}>
                  {!!design.edits && <Readout label="Building edits" value={String(design.edits)} />}
                  {!!design.addedBuildings && <Readout label="Added buildings" value={String(design.addedBuildings)} />}
                </div>
              )}
            </Section>

            <Section n={2} title="Build" open={step === 'build'} onToggle={() => openStep('build')}
              hint={scene?.built ? 'built' : 'not built'}
              summary={scene?.built ? `${scene.buildings_extruded ?? scene.nof_buildings ?? '—'} buildings` : 'not built'}>
              <div style={{ display: 'flex', gap: S.xs }}>
                <div style={{ flex: '0 0 130px' }}>
                  <NumField label="Min footprint" unit="m²" value={minArea} onChange={setMinArea} min={0} max={100000} step={1} />
                </div>
                <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                  <SelectField label="Ground" value={ground} onChange={setGround}
                    options={GROUND_MATERIALS as unknown as string[]}
                    labels={GROUND_MATERIAL_LABELS} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                <FieldToggle label="DEM terrain" on={terrain} onClick={() => setTerrain(!terrain)} />
                <FieldToggle label="Fetch Overture" on={fetchOverture} onClick={() => setFetchOverture(!fetchOverture)} />
                <FieldToggle label="Trees" on={vegetation} onClick={() => setVegetation(!vegetation)} />
              </div>
              {scene && (
                <div style={{ marginTop: S.md, paddingTop: S.sm, borderTop: '1px solid ' + T.bd }}>
                  <Readout label="Scene id" mono value={scene.scene_id} />
                  <Readout label="Buildings" value={`${scene.buildings_extruded ?? scene.nof_buildings ?? '—'} extruded${scene.buildings_skipped ? ` · ${scene.buildings_skipped} skipped` : ''}`} />
                  <Readout label="Meshes" value={String(scene.nof_meshes ?? '—')} />
                  <Readout label="Built" value={fmtWhen(scene.built_at ?? scene.created)} />
                </div>
              )}
              <Actions>
                <button className="sk-btn-primary" style={{ ...btn(busy || !!buildWhy), flex: 1, justifyContent: 'center', padding: '9px 0', fontSize: 13 }}
                  disabled={busy || !!buildWhy} title={buildWhy ?? undefined}
                  onClick={onBuild}>{busy && job?.kind === 'build' ? 'Building…' : 'Build scene'}</button>
              </Actions>
            </Section>
          </GroupFold>          <GroupFold title="Configure" n={3}
            open={group === 'configure'} onToggle={() => openGroup('configure')}>

            <Section n={3} title="Sionna model" open={step === 'sionna'} onToggle={() => openStep('sionna')}
              hint={sio ? `depth ${sio.max_depth}` : 'per scene'}
              summary={!sceneId ? 'no scene'
                : sio ? [
                    `depth ${sio.max_depth}`,
                    sio.diffraction ? 'diffraction' : null,
                    sio.diffuse_reflection ? 'diffuse' : null,
                  ].filter(Boolean).join(' · ') : 'defaults'}>
              {sceneId && sio && (
                <>
                  <FieldLabel>Propagation</FieldLabel>
                  <Switch label="Line of sight"
                    on={!!sio.los} onChange={(v) => setSionna({ los: v })} />
                  <Switch label="Specular reflection"
                    on={!!sio.specular_reflection} onChange={(v) => setSionna({ specular_reflection: v })} />
                  <Switch label="Diffuse reflection"
                    on={!!sio.diffuse_reflection} onChange={(v) => setSionna({ diffuse_reflection: v })} />
                  <Switch label="Refraction"
                    on={!!sio.refraction} onChange={(v) => setSionna({ refraction: v })} />
                  <Switch label="Diffraction"
                    on={!!sio.diffraction} onChange={(v) => setSionna({ diffraction: v })} />

                  <div style={{ width: '50%', paddingRight: S.xs / 2, marginTop: S.sm }}>
                    <NumField label="Bounces" value={Number(sio.max_depth) || 5} min={0} max={10} step={1}
                      onChange={(v) => setSionna({ max_depth: v })} />
                  </div>

                  <div style={{ marginTop: S.md }}><FieldLabel>Antenna model</FieldLabel></div>
                  <div style={{ display: 'flex', gap: S.xs }}>
                    <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                      <SelectField label="Pattern" value={String(sio.array_pattern ?? 'tr38901')}
                        onChange={(v) => setSionna({ array_pattern: v })}
                        options={['tr38901', 'iso', 'dipole', 'hw_dipole']}
                        labels={['3GPP 38.901', 'isotropic', 'dipole', 'half-wave dipole']} />
                    </div>
                    <div style={{ flex: '0 0 96px' }}>
                      <SelectField label="Polarisation" value={String(sio.array_pol ?? 'V')}
                        onChange={(v) => setSionna({ array_pol: v })}
                        options={['V', 'H', 'VH', 'cross']} />
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: S.xs }}>
                    <NumField label="Rows" hint="0 = config" value={Number(sio.array_rows) || 0} min={0} max={8} step={1}
                      onChange={(v) => setSionna({ array_rows: v || null })} />
                    <NumField label="Columns" hint="0 = config" value={Number(sio.array_cols) || 0} min={0} max={8} step={1}
                      onChange={(v) => setSionna({ array_cols: v || null })} />
                  </div>

                  <details style={{ marginTop: S.md }} open={sioAdv}
                    onToggle={(e) => setSioAdv((e.target as HTMLDetailsElement).open)}>
                    <summary style={{ cursor: 'pointer', fontSize: 11.5, fontWeight: 700,
                                      color: advChanged.length ? T.brand : T.mut }}>
                      Advanced
                      <span style={{ fontWeight: 600, color: T.mut, marginLeft: 6 }}>
                        {advChanged.length
                          ? `${advChanged.length} changed · ${advSummary}`
                          : advSummary}
                      </span>
                    </summary>
                    <div style={{ marginTop: S.sm }}>
                      <Switch label="Edge diffraction"
                        on={!!sio.edge_diffraction} onChange={(v) => setSionna({ edge_diffraction: v })} />
                      <Switch label="Synthetic array"
                        on={!!sio.synthetic_array} onChange={(v) => setSionna({ synthetic_array: v })} />
                      <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                        <NumField label="Samples / source"
                          value={Number(sio.samples_per_src) || 1000000}
                          min={1000} max={100000000} step={100000}
                          onChange={(v) => setSionna({ samples_per_src: v })} />
                        <NumField label="Seed"
                          value={Number(sio.seed) || 42} min={0} max={1000000} step={1}
                          onChange={(v) => setSionna({ seed: v })} />
                      </div>
                      <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                        <NumField label="Carrier override" unit="GHz" hint="0 = config"
                          value={sio.freq_hz ? +(Number(sio.freq_hz) / 1e9).toFixed(5) : 0}
                          min={0} max={10} step={0.001}
                          onChange={(v) => setSionna({ freq_hz: v ? v * 1e9 : null })} />
                        <NumField label="RR depth" hint="−1 = auto"
                          value={Number(sio.rr_depth ?? -1)} min={-1} max={10} step={1}
                          onChange={(v) => setSionna({ rr_depth: v })} />
                      </div>
                    </div>
                  </details>

                  <Actions>
                    <button className="sk-btn-ghost" onClick={() => setSionna({ reset: true } as never)}
                      style={{ flex: 1, justifyContent: 'center', padding: '9px 0', fontSize: 12.5 }}>
                      Reset to defaults
                    </button>
                  </Actions>
                </>
              )}
            </Section>

            <Section n={4} title="UE" open={step === 'ue'} onToggle={() => openStep('ue')}
              hint={ueEff ? `${ue?.n_ues ?? 1} × ${ueEff.n_rb_effective} PRB` : 'per scene'}
              summary={!sceneId ? 'no scene'
                : ueEff ? [
                    `${ue?.n_ues ?? 1} UE${Number(ue?.n_ues ?? 1) > 1 ? 's' : ''}`,
                    `${ueEff.n_rb_effective} PRB`,
                    Number(ue?.sd) === 16777215 ? 'no SD' : `SD ${ue?.sd}`,
                  ].filter(Boolean).join(' · ') : 'defaults'}>
              {sceneId && ue && ueEff && (() => {
                const cell = (ueEff.cell ?? {}) as Record<string, number | string>
                const fixed = ueEff.fixed as Record<string, number>
                const mhz = (hz: number) => (Number(hz) / 1e6).toFixed(2) + ' MHz'
                return (
                <>
                  {(ueEff.carrier_mismatch as boolean) && (
                    <Hint tone="warn">
                      Carrier mismatch · cell {mhz(Number(cell.freq_hz))} · UE {mhz(fixed.freq_hz)}
                    </Hint>
                  )}

                  <div style={{ border: '1px solid ' + T.bdBrand, background: T.fillBrand,
                                borderRadius: 10, padding: '7px 11px' }}>
                    <Readout label="UEs" value={String(ue.n_ues ?? 1)} />
                    <Readout label="Resource blocks"
                      value={`${ueEff.n_rb_effective}${ue.n_rb ? '' : ' · auto'}`} />
                    <Readout label="Carrier" value={`${mhz(fixed.freq_hz)} · n${fixed.band} · µ${fixed.numerology}`} />
                    <Readout label="Slice"
                      value={`SST ${fixed.sst} · ${Number(ue.sd) === 16777215 ? 'no SD' : 'SD ' + ue.sd}`} />
                    <Readout label="IMSI" mono value={String(ue.imsi_base ?? '')} />
                    <Readout label="Movement"
                      tone={ueEff.move_effective === 'route' && Number(ueEff.route_points) < 2 ? 'warn' : undefined}
                      value={ueEff.move_effective !== 'route' ? 'static'
                        : Number(ueEff.route_points) >= 2
                          ? `walks ${ueEff.route_len_m} m at ${Number(ue.speed_mps ?? 1.4).toFixed(1)} m/s`
                          : 'no path'} />
                  </div>

                  <Group title="Radio">
                    <div style={{ display: 'flex', gap: S.xs }}>
                      <NumField label="UEs" value={Number(ue.n_ues) || 1} min={1} max={16} step={1}
                        onChange={(v) => setUeParam({ n_ues: v })} />
                      <NumField label="Resource blocks" value={Number(ue.n_rb) || 0} min={0} max={273} step={1}
                        onChange={(v) => setUeParam({ n_rb: v || null })} />
                    </div>

                    <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                      <SelectField label="SSB search"
                        value={ue.ssb_scan == null ? 'auto' : String(ue.ssb_scan)}
                        onChange={(v) => setUeParam({ ssb_scan: v === 'auto' ? null : Number(v) })}
                        options={['auto', '1', '0']}
                        labels={['auto', 'scan', 'fixed']} />
                      <NumField label="SSB index" value={Number(ue.ssb) || 0} min={0} max={63} step={1}
                        disabled={String(ueEff.ssb_scan_effective) === '1'}
                        onChange={(v) => setUeParam({ ssb: v })} />
                    </div>
                    </Group>

                  <Group title="Movement">
                    <div style={{ display: 'flex', gap: S.xs }}>
                      <SelectField label="While streaming"
                        value={String(ueEff.move_effective ?? ue.move ?? 'static')}
                        onChange={(v) => setUeParam({ move: v })}
                        options={['static', 'route']}
                        labels={['static', 'route']} />
                      <NumField label="Speed" unit="m/s" value={Number(ue.speed_mps ?? 1.4)}
                        min={0.1} max={60} step={0.1}
                        disabled={ueEff.move_effective !== 'route'}
                        onChange={(v) => setUeParam({ speed_mps: v })} />
                    </div>
                    {Number(ueEff.route_points) >= 2 ? (
                      <>
                        <Hint>{String(ueEff.route_points)} corners · one lap ≈
                          {' '}{Math.round(Number(ueEff.route_len_m) / Number(ue.speed_mps ?? 1.4))} s</Hint>
                        <div style={{ marginTop: S.xs }}>
                          <Switch label="Round trip"
                            disabled={ueEff.move_effective !== 'route'}
                            on={ue.loop_route !== false} onChange={(v) => setUeParam({ loop_route: v })} />
                        </div>
                      </>
                    ) : (
                      <Hint>No path</Hint>
                    )}
                  </Group>

                  <details style={{ marginTop: S.md }} open={ueAdv}
                    onToggle={(e) => setUeAdv((e.target as HTMLDetailsElement).open)}>
                    <summary style={{ cursor: 'pointer', fontSize: 11.5, color: T.mut, fontWeight: 700 }}>
                      Advanced
                    </summary>

                    <Group title="SIM keys">
                      <Readout label="Key" mono value={String(ue.key ?? '')} />
                      <Readout label="OPc" mono value={String(ue.opc ?? '')} />
                    </Group>

                    <Group title="Timing and cores">
                      <Readout label="Cores" mono
                        value={`UE ${String(ue.ue_cpus ?? '—')} · proxy ${String(ue.proxy_cpus ?? '—')}`} />
                      <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                        <NumField label="Stagger" unit="s"
                          value={Number(ue.stagger_s ?? 1.5)}
                          min={0} max={60} step={0.5} onChange={(v) => setUeParam({ stagger_s: v })} />
                        <NumField label="RT priority" hint="0 = default"
                          value={Number(ue.ue_rt_prio) || 0} min={0} max={99} step={1}
                          onChange={(v) => setUeParam({ ue_rt_prio: v || null })} />
                      </div>
                      <div style={{ marginTop: S.xs }}>
                        <Switch label="Three-quarter sampling (-E)"
                          on={!!ue.tq_sampling} onChange={(v) => setUeParam({ tq_sampling: v })} />
                      </div>
                    </Group>

                  </details>

                  <Actions>
                    <button className="sk-btn-ghost" onClick={() => setUeParam({ reset: true } as never)}
                      style={{ flex: 1, justifyContent: 'center', padding: '9px 0', fontSize: 12.5 }}>
                      Reset to defaults
                    </button>
                  </Actions>
                </>
                )
              })()}
            </Section>

            <Section n={5} title="O-DU" open={step === 'odu'} onToggle={() => openStep('odu')}
              summary={du ? du.name.replace(/\.ya?ml$/, '') : 'manual'}>
              <SelectField label="Config file" value={duPath} onChange={setDuPath}
                options={['', ...duConfigs.map((d) => d.path)]}
                labels={['(manual)', ...duConfigs.map((d) => `${d.name}${d.sionna_driver ? ' · sionna' : ''}`)]} />
              {du ? (
                <div style={{ marginTop: 6 }}>
                  <Readout label="Sample rate" mono value={`${(du.srate_hz ?? 0) / 1e6} Msps`} tone="ok" />
                  <Readout label="Carrier" mono
                    value={du.dl_freq_hz ? `${(du.dl_freq_hz / 1e9).toFixed(5)} GHz` : '—'}
                    sub={du.dl_arfcn ? `ARFCN ${du.dl_arfcn}` : undefined} />
                  {du.bw_mhz ? <Readout label="Bandwidth" mono value={`${du.bw_mhz} MHz`} /> : null}
                  <Readout label="Publishes to" mono value={du.live_bind ?? '—'} />
                  {!du.sionna_driver && <Hint tone="warn">No sionna driver</Hint>}
                </div>
              ) : (
                <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                  <NumField label="Sample rate Msps" value={srate} onChange={setSrate} min={0.1} max={1000} step={1.92} />
                </div>
              )}
            </Section>
          </GroupFold>          <GroupFold title="Solve" n={2}
            open={group === 'solve'} onToggle={() => openGroup('solve')}>

            <Section n={6} title="Ray trace" open={step === 'trace'} onToggle={() => openStep('trace')}
              hint={trace ? `${trace.links?.length ?? 0} link(s)` : '-'}
              summary={trace ? `${trace.links?.length ?? 0} link(s) traced` : 'not traced'}>
              <Actions>
                <button className="sk-btn-primary" style={{ ...btn(busy || !!traceWhy), flex: '3 1 0', justifyContent: 'center', padding: '9px 0', fontSize: 13 }}
                  disabled={busy || !!traceWhy} title={traceWhy ?? undefined} onClick={onTrace}>
                  {busy && job?.kind === 'trace' ? 'Tracing…' : 'Trace every cell'}
                </button>
                <button className="sk-btn-ghost" style={{ ...btn(!savedRays.length), flex: '2 1 0',
                  justifyContent: 'center' }}
                  disabled={!savedRays.length} onClick={toggleRays}
                  title={!savedRays.length ? 'No rays' : undefined}>
                  {raysOn && savedRays.length > 0 ? 'Hide rays' : 'Show rays'}
                  {savedRays.length ? ' \u00b7 ' + savedRays.length : ''}
                </button>
              </Actions>
              {transmitters.length > 1 && (
                <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 700, marginTop: S.sm }}>
                  Cell
                </div>
              )}
              {transmitters.length > 1 && (
                <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                  {['', ...transmitters.map((tx) => tx.name)].map((name) => (
                    <button key={name || 'all'} onClick={() => { setTxSelect(name); chooseRayTx(name) }}
                      style={{ flex: 1, fontSize: 11, fontWeight: 700, padding: '5px 0',
                        borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit',
                        border: `1px solid ${rayTx === name ? T.brand : T.bd}`,
                        background: rayTx === name ? T.fillBrand : 'transparent',
                        color: rayTx === name ? T.brand : T.mut }}>
                      {name || 'Both cells'}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 4, marginTop: S.xs }}>
                {(['all', 'direct', 'strong', 'weak'] as const).map((b) => (
                  <button key={b} onClick={() => chooseBand(b)} disabled={!savedRays.length}
                    style={{ flex: 1, fontSize: 11, fontWeight: 700, padding: '5px 0',
                      borderRadius: 6, cursor: savedRays.length ? 'pointer' : 'default',
                      border: `1px solid ${rayBand === b ? T.brand : T.bd}`,
                      background: rayBand === b ? T.fillBrand : 'transparent',
                      color: rayBand === b ? T.brand : T.mut }}>
                    {b === 'all' ? 'All' : b === 'direct' ? 'Direct'
                      : b === 'strong' ? 'Strong' : 'Weak'}
                  </button>
                ))}
              </div>
              <details style={{ marginTop: S.sm }}>
                <summary style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700, color: T.mut }}>
                  Legend
                </summary>
                <div style={{ marginTop: S.sm, fontSize: 11, color: T.mut, lineHeight: 1.7 }}>
                  <RayKey c="#4DB2C3" label="direct" />
                  <RayKey c="#F59E0B" label="≥ 1% energy" />
                  <RayKey c="#D55586" label="< 1% energy" />
                  <div style={{ marginTop: 3 }}>
                    Dots: amber reflection · purple refraction · green diffraction
                  </div>
                </div>
              </details>
              {sceneId && (
                <RouteWalk sceneId={sceneId} version={routeVersion} busy={busy} post={post}
                  canTrace={design.hasRoute} onTrace={() => void onRouteTrace()}
                  originLonLat={scene?.origin_lonlat ?? null}
                  onLeave={() => { if (savedRays.length) post({ type: 'sk-load-rays', paths: savedRays, origin_lonlat: scene?.origin_lonlat ?? null }) }} />
              )}

              {trace && (
                <>
                  <div style={{ marginTop: S.md }}>
                    <Readout label="Carrier" mono value={`${(trace.carrier_hz / 1e9).toFixed(3)} GHz · n${trace.band}`} />
                    <Readout label="Array" value={`${trace.array.rows}×${trace.array.cols} ${trace.array.pattern} · ${trace.tx_power_dbm} dBm`} />
                    <Readout label="Sample rate" mono value={`${(trace.srate_hz / 1e6).toFixed(2)} Msps`} />
                    <Readout label="Taps" value={`${trace.taps.taps}/${trace.taps.wanted} · ${Math.round(trace.taps.span_m)} m`} tone={trace.taps.clamped ? 'warn' : 'ok'} />
                  </div>
                  {trace.taps.clamped && (
                    <Hint tone="warn">
                      Taps truncated
                    </Hint>
                  )}
                  <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: T.mut, fontWeight: 700, textAlign: 'left' }}>
                        <th style={th}>UE</th><th style={th}>TX</th><th style={th}>Paths</th><th style={{ ...th, textAlign: 'right' }}>Gain</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(trace.matrix ?? trace.links.map((l) => ({ ue: l.ue, tx: trace.serving_tx.name, paths: l.paths, gain_db: l.gain_db, best: true })))
                        .map((m, i) => (
                          <tr key={i} style={{ background: m.best ? T.fillBrand : undefined }}>
                            <td style={{ ...td, fontWeight: 700 }} className="sk-mono">{m.ue}</td>
                            <td style={{ ...td }} className="sk-mono">{m.tx}{m.best ? ' ★' : ''}</td>
                            <td style={{ ...td, color: m.paths ? T.ink : T.bad }}>{m.paths}</td>
                            <td style={{ ...td, textAlign: 'right', fontWeight: 700, color: m.paths ? T.ink : T.bad }}>
                              {m.paths ? fmtDb(m.gain_db) : 'no path'}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  </>
              )}
            </Section>

            <Section n={7} title="Coverage" open={step === 'coverage'} onToggle={() => openStep('coverage')}
              hint={scene?.has_coverage ? 'available' : '—'}
              summary={scene?.has_coverage ? 'available' : 'not solved'}>
              <div style={{ display: 'flex', gap: S.xs }}>
                <NumField label="Samples / tx" value={samples} onChange={setSamples} min={1000} max={100000000} step={50000} />
                <NumField label="Cell size" unit="m" value={cellSize} onChange={setCellSize} min={0.5} max={100} step={1} />
              </div>
              <div style={{ display: 'flex', gap: S.xs, marginTop: S.sm }}>
                <NumField label="Depth" value={covDepth} onChange={setCovDepth} min={0} max={10} step={1} />
                <NumField label="Scale min" unit="dB" value={vmin} onChange={setVmin} min={-300} max={0} step={5} />
                <NumField label="Scale max" unit="dB" value={vmax} onChange={setVmax} min={-300} max={0} step={5} />
              </div>
              {cellGrid && (
                <Hint tone={cellGrid.tooMany ? 'warn' : undefined}>
                  {cellGrid.tooMany
                    ? `${cellGrid.cells.toLocaleString()} cells · too many`
                    : `≈ ${cellGrid.cells.toLocaleString()} cells · ${cellGrid.w} × ${cellGrid.h} m`}
                </Hint>
              )}
              {scene?.coverage_stats && (
                <div style={{ marginTop: S.sm }}>
                  <Readout label="Reached" value={`${scene.coverage_stats.covered_cells} / ${scene.coverage_stats.total_cells} cells`} />
                  {coverageBand(scene.coverage_stats) && (
                    <Readout label="Coverage" value={coverageLabel(coverageBand(scene.coverage_stats)!)} />
                  )}
                  <Readout label="Path gain" value={`${Math.round(scene.coverage_stats.gain_db_min ?? 0)} … ${Math.round(scene.coverage_stats.gain_db_max ?? 0)} dB`} />
                  <div style={{ height: 9, borderRadius: 5, marginTop: S.sm, background: 'linear-gradient(90deg,#440154,#35658A,#35B779,#FDE725)' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6B7C85', fontWeight: 600, marginTop: 4 }}>
                    <span>{vmin} dB</span><span>{vmax} dB</span>
                  </div>
                </div>
              )}
              <Actions>
                <button className="sk-btn-primary" style={{ ...btn(busy || !!coverageWhy), flex: '1 1 130px', justifyContent: 'center', padding: '9px 0', fontSize: 13 }}
                  disabled={busy || !!coverageWhy} title={coverageWhy ?? undefined}
                  onClick={onCoverage}>{busy && job?.kind === 'coverage' ? 'Solving…' : 'Compute coverage'}</button>
                <button className="sk-btn-ghost" style={{ ...btn(!scene?.has_coverage), flex: '1 1 110px', justifyContent: 'center', padding: '9px 0', fontSize: 13 }}
                  disabled={!scene?.has_coverage} onClick={toggleCoverage}>
                  {coverageOn ? 'Hide overlay' : 'Show overlay'}
                </button>
              </Actions>
            </Section>
          </GroupFold>          <GroupFold title="Results" n={4}
            open={group === 'results'} onToggle={() => openGroup('results')}>

            <Section n={8} title="Link KPIs" open={step === 'kpis'} onToggle={() => openStep('kpis')}
>
              {sceneId
                ? <LinkKpis sceneId={sceneId}
                    saved={(scene as any)?.link_kpis?.kpis ?? null}
                    savedOf={(scene as any)?.link_kpis_of ?? null}
                    savedNf={(scene as any)?.link_kpis_nf ?? null}
                    tracedAt={(scene as any)?.traced_at ?? null} />
                : <Hint>No scene</Hint>}
            </Section>

            <Section n={9} title="Channel export" open={step === 'exports'}
              onToggle={() => openStep('exports')}
              hint={nExports == null ? '—' : `${nExports}`}
              summary={nExports == null ? 'none'
                : nExports === 1 ? '1 export' : `${nExports} exports`}>
              {sceneId
                ? <ChannelExports sceneId={sceneId} onCount={setNExports} />
                : <Hint>No scene</Hint>}
            </Section>

            <Section n={10} title="Scene package" open={step === 'package'} onToggle={() => openStep('package')}
              hint={sceneId ? undefined : 'no scene'}>
              {sceneId && <SceneSealState sceneId={sceneId} />}
              {sceneId
                ? <SceneBundles sceneId={sceneId} />
                : <Hint>No scene</Hint>}
            </Section>
          </GroupFold>
          <div style={{ flex: '1 1 auto', minHeight: 8 }} />
          <div style={{ padding: '10px 18px 24px' }}>
            <button className="sk-btn-ghost" style={{ width: '100%', justifyContent: 'center', padding: '8px 0', fontSize: 13 }}
              onClick={() => setShowConsole((v) => !v)}>
              {showConsole ? 'Hide' : 'Show'} console
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  )
}

const PANEL_W = 320
const PANEL_INSET = 12
const PANEL_HANDLE_W = 22
const HANDLE_TOP = 37

const NODE_COLOR: Record<string, string> = { gnb: '#FF4D4F', tower: '#E8B04B', ue: '#4DB2C3' }
const ROUTE_COLOR = '#A78BFA'
const MODE_LABEL: Record<string, string> = {
  area: 'area', gnb: 'gNB', tower: 'tower', ue: 'UE', route: 'UE route',
  edit: 'buildings', model: 'model',
}

const MAPT = {
  panel: 'linear-gradient(135deg, rgba(34,48,63,.88) 0%, rgba(34,48,63,.80) 45%, rgba(34,48,63,.76) 100%)',
  ink: '#E9F0F6',
  mut: '#9FB2C4',
  dim: '#8195A8',
  bd: 'rgba(255,255,255,.14)',
  sunk: 'rgba(8,14,22,.42)',
  acc: '#327985',
  bad: '#FF8A8F',
  warn: '#F0A83C',
}

function Switch({ label, hint, on, onChange, disabled, showHint }: {
  label: string; hint?: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean
  showHint?: boolean
}) {
  return (
    <label title={hint}
      style={{ display: 'flex', alignItems: showHint ? 'flex-start' : 'center', gap: 9,
               padding: showHint ? '6px 0' : '4px 0',
               cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }}>
      <input type="checkbox" checked={on} disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ marginTop: showHint ? 2 : 0, accentColor: T.brandFill, width: 15, height: 15,
                 flex: '0 0 auto' }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        {hint && showHint && (
          <span style={{ display: 'block', fontSize: 11, color: T.mut, marginTop: 1 }}>{hint}</span>
        )}
      </span>
    </label>
  )
}

function AskDialog({ kind, sceneName, initial, onCancel, onConfirm }: {
  kind: 'save' | 'delete'
  sceneName: string
  initial: string
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const inputRef = useRef<HTMLInputElement>(null)
  const danger = kind === 'delete'
  const ready = danger || value.trim().length > 0

  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select() }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return createPortal((
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(6,12,20,.55)', backdropFilter: 'blur(3px)',
    }}>
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{
        width: 'min(430px, 92vw)', borderRadius: 16, overflow: 'hidden', color: MAPT.ink,
        background: MAPT.panel,
        backdropFilter: 'blur(16px) saturate(150%)',
        WebkitBackdropFilter: 'blur(16px) saturate(150%)',
        border: '1px solid ' + MAPT.bd,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.10), 0 18px 44px rgba(6,14,24,.5)',
      }}>
        <div style={{ padding: `${S.md}px ${S.md}px ${S.sm}px` }}>
          <div style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-.2px' }}>
            {danger ? 'Delete scene? Cannot be undone.' : 'Save scene'}
          </div>
          {danger ? (
            <div className="sk-mono" style={{ marginTop: 10, padding: '7px 9px', borderRadius: 9,
                                              background: MAPT.sunk, fontSize: 12, color: MAPT.ink }}>
              {sceneName}
            </div>
          ) : (
            <input ref={inputRef} value={value} maxLength={80}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && ready) onConfirm(value) }}
              placeholder="Name"
              style={{ marginTop: 10, width: '100%', boxSizing: 'border-box', borderRadius: 9,
                       padding: '9px 10px', fontSize: 13, fontFamily: 'inherit',
                       color: MAPT.ink, background: MAPT.sunk,
                       border: '1px solid ' + MAPT.bd, outline: 'none' }} />
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: S.xs,
                      padding: `${S.sm}px ${S.md}px ${S.md}px` }}>
          <button onClick={onCancel} style={{
            padding: '8px 14px', fontSize: 12.5, fontWeight: 700, borderRadius: 9,
            cursor: 'pointer', color: MAPT.ink, background: 'transparent',
            border: '1px solid ' + MAPT.bd,
          }}>Cancel</button>
          <button onClick={() => ready && onConfirm(value)} disabled={!ready} style={{
            padding: '8px 14px', fontSize: 12.5, fontWeight: 800, borderRadius: 9,
            cursor: ready ? 'pointer' : 'not-allowed', opacity: ready ? 1 : .5,
            color: danger ? '#2A0E10' : '#FFFFFF',
            background: danger ? MAPT.bad : MAPT.acc,
            border: '1px solid ' + (danger ? MAPT.bad : MAPT.acc),
          }}>{danger ? 'Delete scene' : 'Save'}</button>
        </div>
      </div>
    </div>
  ), document.body)
}

function ConfigEditor({ path, name, onClose }: { path: string; name: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setMsg('Loading…')
    mapApi.duConfigText(path)
      .then((d: any) => {
        if (d?.ok) { setText(d.text); setSaved(d.text); setMsg('') }
        else setMsg(d?.error || 'Could not read that config.')
      })
      .catch(() => setMsg('Could not read that config.'))
  }, [path])

  const dirty = text != null && text !== saved

  async function save() {
    if (text == null) return
    setBusy(true); setMsg('Saving…')
    try {
      const d: any = await mapApi.saveDuConfigText(path, text)
      if (!isError(d) && d?.ok) { setSaved(text); setMsg('Saved') }
      else setMsg((isError(d) && d.error) || d?.error || 'Could not save.')
    } catch { setMsg('Could not save') }
    setBusy(false)
  }

  return createPortal((
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center',
      justifyContent: 'center', background: 'rgba(6,12,20,.55)', backdropFilter: 'blur(3px)',
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        width: 'min(1000px, 94vw)', height: 'min(900px, 90vh)', display: 'flex',
        flexDirection: 'column', borderRadius: 16, overflow: 'hidden', color: MAPT.ink,
        background: MAPT.panel,
        backdropFilter: 'blur(16px) saturate(150%)',
        WebkitBackdropFilter: 'blur(16px) saturate(150%)',
        border: '1px solid ' + MAPT.bd,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,.10), 0 18px 44px rgba(6,14,24,.5)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: S.sm,
                      padding: `${S.sm}px ${S.md}px`, borderBottom: '1px solid ' + MAPT.bd }}>
          <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-.2px' }}>gNB config</span>
          <span className="sk-mono" style={{ fontSize: 11.5, color: MAPT.mut }}>{name}</span>
          {dirty && <span style={{ fontSize: 11, fontWeight: 800, color: MAPT.warn }}>unsaved</span>}
          <button type="button" title="Close" aria-label="Close the config editor" onClick={onClose}
            style={{ marginLeft: 'auto', cursor: 'pointer', color: MAPT.dim, fontWeight: 700,
                     lineHeight: 1, padding: '2px 6px', borderRadius: 7, background: 'none',
                     border: 'none', fontFamily: 'inherit', fontSize: 13 }}>✕</button>
        </div>
        <textarea value={text ?? ''} onChange={(e) => setText(e.target.value)}
          spellCheck={false} disabled={text == null}
          style={{ flex: 1, margin: S.md, marginBottom: 0, padding: S.md, borderRadius: 10,
                   border: '1px solid ' + MAPT.bd, background: MAPT.sunk, color: MAPT.ink,
                   fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, lineHeight: 1.6,
                   resize: 'none', outline: 'none' }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: S.sm, padding: S.md }}>
          <span style={{ flex: 1, fontSize: 11.5, fontWeight: 600,
                         color: /could not|not valid/i.test(msg) ? MAPT.bad : MAPT.mut }}>{msg}</span>
          <button onClick={() => setText(saved)} disabled={!dirty}
            style={{ padding: '8px 14px', fontSize: 12.5, fontFamily: 'inherit', fontWeight: 600,
                     borderRadius: 10, cursor: dirty ? 'pointer' : 'default',
                     background: 'rgba(255,255,255,.06)', color: dirty ? MAPT.ink : MAPT.dim,
                     border: '1px solid ' + MAPT.bd, opacity: dirty ? 1 : 0.6 }}>Revert</button>
          <button onClick={save} disabled={!dirty || busy}
            style={{ padding: '8px 16px', fontSize: 12.5, fontFamily: 'inherit', fontWeight: 700,
                     borderRadius: 10, cursor: (!dirty || busy) ? 'default' : 'pointer',
                     background: (!dirty || busy) ? 'rgba(255,255,255,.06)' : MAPT.acc,
                     color: (!dirty || busy) ? MAPT.dim : '#fff',
                     border: '1px solid ' + ((!dirty || busy) ? MAPT.bd : MAPT.acc) }}>Save</button>
        </div>
      </div>
    </div>
  ), document.body)
}

function JobConsole({ job, onClose, onCancel, rightInset }: {
  job: Job | null; onClose: () => void; onCancel: () => void;
  rightInset: number
}) {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => { ref.current?.scrollTo(0, ref.current.scrollHeight) }, [job?.log?.length, job?.message])
  const active = job && (job.state === 'running' || job.state === 'queued')
  const tone = job?.state === 'failed' ? { fg: MAPT.bad, bg: 'rgba(255,138,143,.14)', bd: 'rgba(255,138,143,.4)' }
    : job?.state === 'done' ? { fg: MAPT.acc, bg: 'rgba(18,160,181,.16)', bd: 'rgba(18,160,181,.45)' }
    : job?.state === 'cancelled' ? { fg: MAPT.mut, bg: 'rgba(255,255,255,.06)', bd: MAPT.bd }
    : { fg: MAPT.warn, bg: 'rgba(240,168,60,.16)', bd: 'rgba(240,168,60,.42)' }
  return (
    <div style={{
      position: 'absolute', left: PANEL_INSET, right: rightInset,
      bottom: PANEL_INSET, maxHeight: 240, borderRadius: 16, color: MAPT.ink,
      background: MAPT.panel,
      backdropFilter: 'blur(16px) saturate(150%)',
      WebkitBackdropFilter: 'blur(16px) saturate(150%)',
      border: '1px solid ' + MAPT.bd,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,.10), 0 14px 38px rgba(6,14,24,.45)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: S.sm,
                    padding: `${S.sm}px ${S.md}px`, borderBottom: '1px solid ' + MAPT.bd }}>
        <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: '-.2px' }}>
          {job ? job.label : 'Pipeline console'}
        </span>
        {job && (
          <span style={{ fontSize: 11, fontWeight: 800, borderRadius: 999, padding: '3px 9px',
                         background: tone.bg, color: tone.fg, border: '1px solid ' + tone.bd }}>
            {job.state} · {job.elapsed_s.toFixed(1)}s
          </span>
        )}
        {active && (
          <button type="button" onClick={onCancel} style={{ cursor: 'pointer', fontSize: 11.5,
                 fontWeight: 700, fontFamily: 'inherit', background: 'none',
                 color: MAPT.bad, border: '1px solid rgba(255,138,143,.4)', borderRadius: 8, padding: '3px 9px' }}>
            Cancel
          </button>
        )}
        <button type="button" title="Hide" aria-label="Hide the job console" onClick={onClose}
          style={{ marginLeft: 'auto', cursor: 'pointer', color: MAPT.dim, fontWeight: 700,
                   lineHeight: 1, padding: '2px 6px', borderRadius: 7, background: 'none',
                   border: 'none', fontFamily: 'inherit', fontSize: 13 }}>✕</button>
      </div>
      <div ref={ref} style={{ overflowY: 'auto', margin: S.sm, padding: `${S.sm}px ${S.md}px`,
                              borderRadius: 10, background: MAPT.sunk,
                              border: '1px solid ' + MAPT.bd,
                              fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, lineHeight: 1.7 }}>
        {(job?.log ?? ['No jobs']).map((l, i) => (
          <div key={i} style={{ color: /error|Error|Traceback|WARNING|warning/.test(l) ? MAPT.bad : MAPT.mut,
                                whiteSpace: 'pre-wrap' }}>{l}</div>
        ))}
      </div>
    </div>
  )
}

function Stats({ items }: { items: { n: number; label: string; color: string }[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: S.xs,
                  paddingBottom: S.sm, borderBottom: '1px solid ' + T.bd }}>
      {items.map((it) => (
        <div key={it.label} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 17, letterSpacing: '-.4px',
                        fontWeight: it.n ? 800 : 600,
                        color: it.n ? T.ink : T.dim }}>{it.n}</div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 2,
                        fontSize: 11, color: T.mut, fontWeight: 700 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: it.color,
                           opacity: it.n ? 1 : .45 }} />
            {it.label}
          </div>
        </div>
      ))}
    </div>
  )
}

function NumField({ label, unit, value, onChange, min, max, step, disabled, hint, title }: {
  label: string; unit?: string; value: number; onChange: (v: number) => void
  min?: number; max?: number; step?: number; disabled?: boolean; hint?: string
  title?: string
}) {
  return (
    <label title={title} style={{ flex: 1, minWidth: 0 }}>
      <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4,
                     border: '1px solid ' + T.bd, borderRadius: 8, padding: '6px 9px',
                     background: disabled ? T.fill : T.card }}>
        <input type="number" value={value} min={min} max={max} step={step} disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (!isFinite(v)) return
            onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v)))
          }}
          style={{ flex: 1, width: '100%', minWidth: 0, border: 0, outline: 'none', padding: 0,
                   background: 'none', fontSize: 13, fontFamily: 'inherit', fontWeight: 600, color: T.ink }} />
        {unit && <span style={{ flex: '0 0 auto', fontSize: 11, color: T.mut, fontWeight: 700 }}>{unit}</span>}
      </span>
      {hint && <span style={{ display: 'block', fontSize: 11, color: T.mut, marginTop: 3 }}>{hint}</span>}
    </label>
  )
}

function NumInline({ value, onChange, suffix, title }: {
  value: number; onChange: (v: number) => void; suffix?: string; title?: string
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <input type="number" value={value} title={title}
        onChange={(e) => { const v = Number(e.target.value); if (isFinite(v)) onChange(v) }}
        style={{ width: 48, border: '1px solid ' + T.bd, borderRadius: 6, padding: '2px 4px', fontSize: 11.5,
               fontFamily: 'inherit', color: T.ink, background: T.card }} />
      {suffix && <span style={{ fontSize: 10.5, color: T.dim }}>{suffix}</span>}
    </span>
  )
}

function GroupFold({ title, n, open, onToggle, children }: {
  title: string; n: number; open: boolean
  onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: '1px solid ' + T.bd }}>
      <button type="button" onClick={onToggle} aria-expanded={open}
        style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                 padding: `12px ${S.lg}px`, cursor: 'pointer', background: 'none',
                 border: 'none', fontFamily: 'inherit', textAlign: 'left',
                 color: 'inherit' }}>
        <span style={{ flex: '0 0 auto', width: 18, height: 18, borderRadius: '50%',
                       display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: 10.5, fontWeight: 800,
                       background: open ? T.brandFill : T.fill,
                       color: open ? '#fff' : T.mut,
                       border: '1px solid ' + (open ? T.brandFill : T.bd) }}>{n}</span>
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 11, fontWeight: 800, letterSpacing: '.9px',
                         textTransform: 'uppercase', color: T.ink }}>{title}</span>
        </span>
        <Caret open={open} />
      </button>
      {open && (
        <div className="sk-group-body" style={{ paddingBottom: 4, marginLeft: 10,
                      borderLeft: '1px solid ' + T.bd }}>{children}</div>
      )}
    </div>
  )
}

function FieldToggle({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <div style={{ flex: 1 }}>
      <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 700, marginBottom: 4 }}>&nbsp;</div>
      <button type="button" onClick={onClick} aria-pressed={on} style={{
        display: 'block', width: '100%', textAlign: 'center', borderRadius: 8, padding: '6px 0',
        fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
        background: on ? T.brandFill : T.card, color: on ? T.card : T.ink,
        border: '1px solid ' + (on ? T.brandFill : T.bd),
      }}>{label}</button>
    </div>
  )
}

function MiniBtn({ children, on, onClick, onPlus, plusTitle, dot, danger, disabled, title }: {
  children: React.ReactNode; on?: boolean; onClick: () => void
  onPlus?: () => void; plusTitle?: string; dot?: string; danger?: boolean
  disabled?: boolean; title?: string
}) {
  return (
    <button type="button" onClick={disabled ? undefined : onClick} title={title}
      disabled={disabled} aria-pressed={on} style={{
      opacity: disabled ? 0.45 : 1,
      pointerEvents: disabled ? 'none' : undefined,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
      padding: '5px 7px', minWidth: 0, fontFamily: 'inherit',
      borderRadius: 8, fontSize: 11.5, fontWeight: 700, cursor: 'pointer',
      background: on ? T.brandFill : T.fill,
      color: on ? '#fff' : danger ? T.bad : T.mut,
      border: '1px solid ' + (on ? T.brandFill : danger ? T.badLine : T.bd),
      whiteSpace: 'nowrap', transition: 'background .12s ease, border-color .12s ease',
    }}>
      {dot && <span style={{ flex: '0 0 auto', width: 6, height: 6, borderRadius: '50%',
                             background: on ? 'rgba(255,255,255,.9)' : dot }} />}
      {children}
      <span role={onPlus ? 'button' : undefined} tabIndex={onPlus ? 0 : undefined}
        title={plusTitle} aria-label={onPlus ? plusTitle : undefined}
        onClick={onPlus ? (e) => { e.stopPropagation(); onPlus() } : undefined}
        onKeyDown={onPlus ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onPlus() }
        } : undefined}
        style={{ flex: '0 0 auto', width: 14, height: 14, borderRadius: 4,
                 display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                 fontSize: 12, lineHeight: 1, visibility: onPlus ? 'visible' : 'hidden',
                 background: on ? 'rgba(255,255,255,.22)' : T.bd, color: on ? '#fff' : T.mut }}>+</span>
    </button>
  )
}

const th: React.CSSProperties = { padding: '4px 0', borderBottom: '1px solid ' + T.bd, fontWeight: 700 }
const td: React.CSSProperties = { padding: '5px 0', borderBottom: '1px solid #F5F8F9' }

function btn(disabled: boolean): React.CSSProperties {
  return { padding: '9px 16px', fontSize: 13.5, flex: '0 0 auto', whiteSpace: 'nowrap',
           opacity: disabled ? 0.5 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }
}
function Rule() {
  return <span aria-hidden style={{ flex: '0 0 auto', width: 1, height: 18,
                                    background: 'rgba(14,26,32,.11)' }} />
}

function Pencil() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" aria-hidden style={{ flex: '0 0 auto' }}>
      <path d="M11.6 1.4a1.4 1.4 0 0 1 2 2L12.3 4.7 10.3 2.7z" fill={T.dim} />
      <path d="M9.2 3.8l2 2L4.4 12.6l-2.6.6.6-2.6z" fill={T.dim} />
    </svg>
  )
}

function Status({ text, busy, bad }: { text: string; busy: boolean; bad: boolean }) {
  if (!text) return null
  const color = bad ? T.bad : busy ? T.brand : T.mut
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7,
                   flex: '1 1 auto', minWidth: 0, maxWidth: 460 }}>
      {(busy || bad) && (
        <span style={{ flex: '0 0 auto', width: 7, height: 7, borderRadius: '50%', background: color,
                       animation: busy && !bad ? 'pulseDot 1.4s ease-in-out infinite' : undefined }} />
      )}
      <span title={text}
        style={{ fontSize: 12.5, fontWeight: 600, color, overflow: 'hidden',
                 textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text}</span>
    </span>
  )
}
