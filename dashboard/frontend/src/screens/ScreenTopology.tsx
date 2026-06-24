import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { Card, PageHeader, StatusPill } from '../components/ui'
import { font, palette } from '../styles/theme'
import { hostsApi, target, type Host } from './ScreenServers'
import { Icon } from '../components/Icon'

interface TNode {
  id: string
  label: string
  kind: string
  col: string | null
  under: string | null
  component: string | null
  external: boolean
  attached?: boolean
  meta: Record<string, string>
}
interface TEdge { from: string; to: string; label: string; both: boolean; dashed: boolean }
interface Topo {
  stack: string
  group: string
  desc: string
  doc: string
  nodes: TNode[]
  edges: TEdge[]
  cols: string[]
  running?: boolean
}

interface MlFeature {
  feature: string; label: string; algo: string; mode: string; model: string; model_source: string
  model_file: { path: string; exists: boolean; bytes?: number; modified?: number; note?: string }
}
interface MlUe {
  rnti: string; cqi?: string; dl_mcs?: string; ul_mcs?: string; dl_bler?: string; ul_bler?: string
  snr_db?: string; bsr?: string; sr_count?: string; ul_brate?: string
}
interface MlSummary {
  features: MlFeature[]
  kpis: { time?: string; dl_bps?: number | null; ul_bps?: number | null; ues?: number | null; failed_uci?: string;
          bsr_timer_ms?: number | null; per_ue?: MlUe[] }
  log: string | null
  log_age_s: number | null
  datasets: { files: number; rows: number }
  lifecycle?: { mode: string; trainable: boolean; training: boolean; model: MlFeature['model_file'] | null }
}

const INK = '#0E1820'
const CARD_H = 232
const MUT = '#5B6E77'
const LINE = '#E2E9EA'

const ROLE: Record<string, string> = {
  core: palette.navy, cu: palette.teal, du: palette.teal, gnb: palette.teal,
  l1: palette.steel, bridge: palette.steel, ue: palette.steel, ues: palette.steel,
  clock: palette.rose, raytrace: palette.rose, dataset: palette.rose, gpu: palette.rose, chip: palette.rose,
}
const KIND_LABEL: Record<string, string> = {
  core: '5G core', cu: 'Central unit', du: 'Distributed unit', gnb: 'gNB', l1: 'Physical layer (L1)',
  bridge: 'FAPI bridge', ue: 'User equipment', ues: 'User equipment (many)',
  ru: 'Radio unit', sdr: 'Software-defined radio', phone: 'Handset', clock: 'Timing', raytrace: 'Channel model',
  dataset: 'Data collection', gpu: 'Accelerator', chip: 'Accelerator',
}
const LANE: Record<string, string> = { core: 'Core', cu: 'CU', l2: 'DU · L2', bridge: 'Bridge', l1: 'L1', radio: 'Radio', ue: 'UE' }
const UP = '#0F8A5F', DOWN = '#B3272C'

const NW = 212, HEAD = 34, SUBH = 22, ROWH = 22, CNW = 150, CNH = 36

interface Port { edge: number; side: 'l' | 'r' | 't' | 'b'; label: string; x: number; y: number }
interface Placed extends TNode { x: number; y: number; w: number; h: number; ports: Port[] }

function layout(t: Topo, compact: boolean, cards: Set<string>) {
  const nw = compact ? CNW : NW
  const dx = nw + (compact ? 54 : 100)
  const top = compact ? 34 : 92
  const used = t.cols.filter((c) => t.nodes.some((n) => n.col === c))
  const xs: Record<string, number> = {}
  const order: Record<string, number> = {}
  const perCol: Record<string, number> = {}
  for (const n of t.nodes) {
    if (!n.col) continue
    xs[n.id] = 40 + used.indexOf(n.col) * dx
    order[n.id] = perCol[n.col] = (perCol[n.col] ?? -1) + 1
  }
  const auxCount: Record<string, number> = {}, auxSeen: Record<string, number> = {}
  for (const n of t.nodes) if (!n.col && n.under) auxCount[n.under] = (auxCount[n.under] ?? 0) + 1
  for (const n of t.nodes) {
    if (n.col || !n.under || xs[n.under] == null) continue
    const k = (auxSeen[n.under] = (auxSeen[n.under] ?? -1) + 1)
    xs[n.id] = xs[n.under] + (k - (auxCount[n.under] - 1) / 2) * (nw + 28)
  }
  const sides: Record<string, { side: Port['side']; edge: number; label: string }[]> = {}
  t.edges.forEach((e, i) => {
    if (xs[e.from] == null || xs[e.to] == null) return
    const ddx = xs[e.to] - xs[e.from]
    const stacked = Math.abs(ddx) < nw * 0.6
    const under = (id: string) => t.nodes.find((n) => n.id === id)?.under
    const downward = under(e.to) === e.from ? true : under(e.from) === e.to ? false : (order[e.to] ?? 99) > (order[e.from] ?? 99)
    const [sa, sb]: Port['side'][] = stacked ? (downward ? ['b', 't'] : ['t', 'b']) : ddx > 0 ? ['r', 'l'] : ['l', 'r']
    ;(sides[e.from] ??= []).push({ side: sa, edge: i, label: e.label })
    ;(sides[e.to] ??= []).push({ side: sb, edge: i, label: e.label })
  })
  const rows = (id: string) => Math.max((sides[id] ?? []).filter((p) => p.side === 'l').length, (sides[id] ?? []).filter((p) => p.side === 'r').length)
  const height = (id: string) => (compact ? CNH : HEAD + SUBH + rows(id) * ROWH + 10)
  const below = (id: string) => (cards.has(id) ? CARD_H + 14 : 0)
  const at: Record<string, Placed> = {}
  const colY: Record<string, number> = {}
  for (const n of t.nodes) {
    if (!n.col) continue
    const y = colY[n.col] ?? top
    at[n.id] = { ...n, x: xs[n.id], y, w: nw, h: height(n.id), ports: [] }
    colY[n.col] = y + height(n.id) + below(n.id) + (compact ? 34 : 64)
  }
  for (const n of t.nodes) {
    if (n.col || !n.under || !at[n.under]) continue
    const a = at[n.under]
    at[n.id] = { ...n, x: xs[n.id], y: a.y + a.h + below(a.id) + (compact ? 40 : 70), w: nw, h: height(n.id), ports: [] }
  }
  for (const [id, list] of Object.entries(sides)) {
    const n = at[id]
    if (!n) continue
    const by = (sd: Port['side']) => list.filter((p) => p.side === sd)
    for (const sd of ['l', 'r'] as const) by(sd).forEach((p, i) => n.ports.push({ ...p,
      x: sd === 'l' ? n.x : n.x + n.w, y: compact ? n.y + n.h / 2 : n.y + HEAD + SUBH + 2 + i * ROWH + ROWH / 2 }))
    for (const sd of ['t', 'b'] as const) by(sd).forEach((p, i, all) => n.ports.push({ ...p,
      x: n.x + (n.w * (i + 1)) / (all.length + 1), y: sd === 't' ? n.y : n.y + n.h + below(id) }))
  }
  const ps = Object.values(at)
  const w = Math.max(...ps.map((p) => p.x + p.w)) + 40
  const h = Math.max(...ps.map((p) => p.y + p.h + below(p.id))) + (compact ? 24 : 44)
  const lanes = used.map((c, i) => ({ key: c, x: 40 + i * dx + nw / 2 }))
  return { at, w, h, lanes, nw, dx }
}

function curve(a: Port, b: Port) {
  const vert = a.side === 'b' || a.side === 't'
  const k = vert ? Math.max(40, Math.abs(b.y - a.y) / 2) : Math.max(40, Math.abs(b.x - a.x) / 2)
  const c1 = vert ? [a.x, a.y + (a.side === 'b' ? k : -k)] : [a.x + (a.side === 'r' ? k : -k), a.y]
  const c2 = vert ? [b.x, b.y + (b.side === 'b' ? k : -k)] : [b.x + (b.side === 'r' ? k : -k), b.y]
  const P = [[a.x, a.y], c1, c2, [b.x, b.y]]
  const mid = [0, 1].map((j) => (P[0][j] + 3 * P[1][j] + 3 * P[2][j] + P[3][j]) / 8)
  const tan = [0, 1].map((j) => 0.75 * (P[1][j] - P[0][j]) + 1.5 * (P[2][j] - P[1][j]) + 0.75 * (P[3][j] - P[2][j]))
  return { d: `M${a.x},${a.y} C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${b.x},${b.y}`, mx: mid[0], my: mid[1], angle: (Math.atan2(tan[1], tan[0]) * 180) / Math.PI }
}

function Diagram({
  t, compact = false, state, onHover, onPick, ml, primary = '',
}: {
  t: Topo
  compact?: boolean
  ml?: MlSummary | null
  primary?: string
  state: Record<string, 'up' | 'down'>
  onHover?: (n: Placed | null, e?: React.MouseEvent) => void
  onPick?: (n: Placed) => void
}) {
  const cards = useMemo(() => new Set(!compact && ml ? t.nodes.filter((n) => n.component === 'ocudu').map((n) => n.id) : []), [t, compact, ml])
  const { at, w, h, lanes, nw, dx } = useMemo(() => layout(t, compact, cards), [t, compact, cards])
  const [hot, setHot] = useState<string | null>(null)
  const status = (n: Placed): 'up' | 'down' | 'ext' => (n.attached ? 'up' : n.component ? (state[n.component] === 'up' ? 'up' : 'down') : 'ext')
  const mid = `m-${t.stack}-${compact ? 'c' : 'f'}`
  const below = (id: string) => (cards.has(id) ? CARD_H + 14 : 0)
  const touches = (i: number) => !hot || t.edges[i].from === hot || t.edges[i].to === hot

  const groups = useMemo(() => {
    if (compact) return []
    const by: Record<string, Placed[]> = {}
    Object.values(at).forEach((n) => { if (n.component) (by[n.meta.host || primary || 'this server'] ??= []).push(n) })
    return Object.entries(by).map(([host, ns], i) => {
      const x0 = Math.min(...ns.map((n) => n.x)) - 16, y0 = Math.min(...ns.map((n) => n.y)) - 40
      const x1 = Math.max(...ns.map((n) => n.x + n.w)) + 16, y1 = Math.max(...ns.map((n) => n.y + n.h + below(n.id))) + 16
      return { host, x0, y0, x1, y1, color: i === 0 ? palette.teal : palette.steel, n: ns.length }
    })
  }, [at, compact, primary]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width="100%" fontFamily={font.sans}
      style={{ display: 'block', maxHeight: compact ? 220 : undefined, maxWidth: compact ? undefined : w, margin: '0 auto' }}>
      <defs>
        <pattern id={`${mid}-grid`} width="24" height="24" patternUnits="userSpaceOnUse">
          <path d="M24 0H0V24" fill="none" stroke="#E4ECEF" strokeWidth="1" />
        </pattern>
        <pattern id={`${mid}-major`} width="120" height="120" patternUnits="userSpaceOnUse">
          <rect width="120" height="120" fill={`url(#${mid}-grid)`} />
          <path d="M120 0H0V120" fill="none" stroke="#D2DEE3" strokeWidth="1" />
        </pattern>
        <style>{`.flow-${mid}{stroke-dasharray:2 10;animation:flow-${mid} 1s linear infinite}@keyframes flow-${mid}{to{stroke-dashoffset:-24}}`}</style>
      </defs>
      <rect width={w} height={h} fill="#FBFDFD" />
      <rect width={w} height={h} fill={`url(#${mid}-major)`} />

      {!compact && lanes.map((l) => (
        <g key={l.key}>
          <g transform={`translate(${l.x - nw / 2},16)`}>
            <text x={0} y={14} fontSize="11.5" fontWeight={800} letterSpacing="1.3" fill={palette.navy}>{(LANE[l.key] ?? l.key).toUpperCase()}</text>
            <path d={`M0,26 H${nw * 0.42} l8,-6 H${nw * 0.62}`} fill="none" stroke="#C6D6DB" strokeWidth="1.4" />
          </g>
        </g>
      ))}

      {groups.map((g) => (
        <g key={g.host}>
          <rect x={g.x0} y={g.y0} width={g.x1 - g.x0} height={g.y1 - g.y0} rx="12" fill="none" stroke={g.color} strokeOpacity=".45" strokeDasharray="6 4" />
          <rect x={g.x0} y={g.y0} width={g.x1 - g.x0} height={24} rx="12" fill={g.color} fillOpacity=".12" />
          <rect x={g.x0} y={g.y0 + 12} width={g.x1 - g.x0} height={12} fill={g.color} fillOpacity=".12" />
          <text x={g.x0 + 12} y={g.y0 + 16.5} fontSize="11.5" fontWeight={800} fill={g.color}>{g.host}</text>
          <text x={g.x1 - 10} y={g.y0 + 16.5} textAnchor="end" fontSize="10.5" fontWeight={600} fill={g.color} opacity=".8">{g.n} component{g.n === 1 ? '' : 's'}</text>
        </g>
      ))}

      {t.edges.map((e, i) => {
        const pa = at[e.from]?.ports.find((p) => p.edge === i), pb = at[e.to]?.ports.find((p) => p.edge === i)
        if (!pa || !pb) return null
        const c = curve(pa, pb)
        const sync = e.dashed
        const up = !sync && [at[e.from], at[e.to]].every((n) => status(n) !== 'down') && [at[e.from], at[e.to]].some((n) => status(n) === 'up')
        const lit = !!hot && touches(i)
        const color = sync ? palette.rose : up ? palette.teal : '#A9BAC0'
        return (
          <g key={i} opacity={touches(i) ? 1 : 0.25}>
            <path d={c.d} fill="none" stroke={color} strokeOpacity={up || sync ? 0.55 : 1} strokeWidth={compact ? 1.4 : lit ? 3 : 2} strokeDasharray={sync ? '6 5' : undefined} />
            {up && !compact && <path d={c.d} fill="none" stroke={palette.teal} strokeWidth={lit ? 3.2 : 2.4} strokeLinecap="round" className={`flow-${mid}`} />}
            {!compact && (
              <g transform={`translate(${c.mx},${c.my}) rotate(${c.angle})`}>
                {e.both
                  ? <circle r="4" fill="#fff" stroke={color} strokeWidth="2" />
                  : <path d="M-6,-5 L5,0 L-6,5 z" fill={color} />}
              </g>
            )}
          </g>
        )
      })}

      {Object.values(at).map((n) => {
        const color = ROLE[n.kind] ?? '#7A8D94'
        const st = status(n)
        const hardware = !ROLE[n.kind]
        const on = hot === n.id
        const dim = !!hot && !on && !t.edges.some((e) => (e.from === hot && e.to === n.id) || (e.to === hot && e.from === n.id))
        const sub = n.meta.host ? `@ ${n.meta.host}` : (KIND_LABEL[n.kind] ?? n.kind)
        return (
          <g key={n.id} transform={`translate(${n.x},${n.y})`} opacity={dim ? 0.45 : st === 'down' ? 0.85 : 1}
            style={{ cursor: onPick ? 'pointer' : 'default' }}
            onMouseEnter={(e) => { setHot(n.id); onHover?.(n, e) }} onMouseMove={(e) => onHover?.(n, e)}
            onMouseLeave={() => { setHot(null); onHover?.(null) }} onClick={() => onPick?.(n)}>
            {cards.has(n.id) && (
              <rect x={-6} y={-6} width={n.w + 12} height={n.h + CARD_H + 26} rx="14" fill="#fff" stroke="#D3DEE2" />
            )}
            <rect width={n.w} height={n.h} rx="10" fill="#fff" stroke={on ? color : hardware ? '#B9C7CC' : '#CFDBDF'} strokeWidth={on ? 2 : 1}
              strokeDasharray={hardware ? '5 4' : undefined}
              style={{ filter: on ? 'drop-shadow(0 10px 18px rgba(39,85,120,.20))' : 'drop-shadow(0 2px 5px rgba(14,24,32,.07))' }} />
            <path d={`M0,10 a10,10 0 0 1 10,-10 h${n.w - 20} a10,10 0 0 1 10,10 v${(compact ? n.h : HEAD) - 10} h${-n.w} z`}
              fill={color} fillOpacity={hardware ? 0.08 : 0.13} />
            {!compact && <line x1={0} x2={n.w} y1={HEAD} y2={HEAD} stroke={color} strokeOpacity=".25" />}
            <text x={compact ? 12 : 14} y={(compact ? n.h : HEAD) / 2 + 4.5} fontSize={compact ? 11 : 13.5} fontWeight={800} fill={INK}>
              {(() => { const m = compact ? 17 : 23; return n.label.length > m ? n.label.slice(0, m - 1) + '…' : n.label })()}
            </text>
            <circle cx={n.w - 14} cy={(compact ? n.h : HEAD) / 2} r="4.5" fill={st === 'up' ? UP : st === 'down' ? DOWN : '#fff'}
              stroke={st === 'ext' ? DOWN : '#fff'} strokeWidth="1.5" />
            {!compact && (
              <>
                <text x={14} y={HEAD + 15} fontSize="11.5" fill={n.meta.host ? palette.navy : MUT} fontWeight={n.meta.host ? 700 : 500}>
                  {sub.length > 22 ? sub.slice(0, 21) + '…' : sub}
                </text>
                <text x={n.w - 14} y={HEAD + 15} textAnchor="end" fontSize="9" fontWeight={800} letterSpacing=".7" fill={st === 'up' ? UP : MUT}>
                  {st === 'up' ? 'UP' : st === 'down' ? 'DOWN' : 'EXTERNAL'}
                </text>
              </>
            )}
            {n.ports.map((p) => {
              const px = p.x - n.x, py = p.y - n.y
              const sync = t.edges[p.edge].dashed
              const pc = sync ? palette.rose : color
              return (
                <g key={`${p.edge}${p.side}`}>
                  {!compact && (p.side === 'l' || p.side === 'r') && (
                    <text x={p.side === 'l' ? 12 : n.w - 12} y={py + 4} textAnchor={p.side === 'l' ? 'start' : 'end'} fontSize="11" fontFamily={font.mono} fill="#46606B">
                      {p.label.length > 16 ? p.label.slice(0, 15) + '…' : p.label}
                    </text>
                  )}
                  <circle cx={px} cy={py} r={compact ? 3.5 : 5} fill="#fff" stroke={pc} strokeWidth="2" />
                  <circle cx={px} cy={py} r={compact ? 1.4 : 2} fill={pc} />
                </g>
              )
            })}
            {cards.has(n.id) && ml && (
              <foreignObject x={0} y={n.h + 8} width={n.w} height={CARD_H}>
                <MlBoxes ml={ml} />
              </foreignObject>
            )}
          </g>
        )
      })}
    </svg>
  )
}

const MODE: Record<string, { fg: string; bg: string }> = {
  'closed loop': { fg: '#fff', bg: palette.rose },
  shadow: { fg: '#fff', bg: palette.steel },
  collect: { fg: '#fff', bg: palette.teal },
  off: { fg: MUT, bg: '#E7EEF1' },
}
const mbps = (b?: number | null) => (b == null ? '—' : b >= 1e6 ? (b / 1e6).toFixed(1) : (b / 1e6).toFixed(2))
const ago = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`)

function MlBoxes({ ml }: { ml: MlSummary }) {
  const k = ml.kpis || {}
  const ues = k.per_ue ?? []
  const stale = ml.log_age_s == null || ml.log_age_s > 15 || !k.time
  const bsr = ml.features.some((f) => f.feature === 'bsr_ml')
  const sum = (key: 'bsr' | 'sr_count') => (ues.some((u) => /^\d+$/.test(u[key] ?? '')) ? ues.reduce((a, u) => a + (Number(u[key]) || 0), 0) : null)
  const na = (v?: string) => (v == null || v === 'n/a' ? '—' : v)
  const cols = '1.1fr .7fr 1fr .9fr .9fr'
  const box: React.CSSProperties = { background: '#fff', border: `1px solid ${LINE}`, borderRadius: 8, padding: '5px 7px' }
  const kpi = (label: string, v: string, unit = '') => (
    <div style={box}>
      <div style={{ fontSize: 9.5, color: palette.greyTeal, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>{label}</div>
      <div style={{ fontSize: 13.5, fontWeight: 800, color: stale ? palette.greyTeal : INK }}>{v}<span style={{ fontSize: 10, fontWeight: 600, color: MUT }}> {unit}</span></div>
    </div>
  )
  const f = ml.features[0]
  const lc = ml.lifecycle
  const phase = lc?.training ? 'train' : f && f.mode !== 'collect' && f.mode !== 'off' ? 'run' : 'collect'
  return (
    <div style={{ fontFamily: font.sans, display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ ...box, borderLeft: `3px solid ${f ? palette.rose : LINE}` }}>
        {f ? (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: INK }}>{f.label}</div>
            <div style={{ display: 'flex', gap: 3, marginTop: 4 }}>
              {(['collect', 'train', 'run'] as const).map((p) => {
                const on = p === phase
                return (
                  <span key={p} style={{ flex: p === 'run' ? 1.6 : 1, textAlign: 'center', fontSize: 9.5, fontWeight: 800, padding: '2px 0', borderRadius: 5,
                                         color: on ? '#fff' : MUT, background: on ? (p === 'run' ? palette.rose : palette.teal) : '#EEF3F4' }}>
                    {p === 'collect' ? 'Collect' : p === 'train' ? (on ? 'Training…' : 'Train') : `Run${f.mode !== 'collect' ? ` · ${f.mode}` : ''}`}
                  </span>
                )
              })}
            </div>
            <div style={{ fontSize: 10, color: MUT, marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={lc?.model?.path}>
              {lc?.model?.exists && lc.model.modified ? `trained model · ${new Date(lc.model.modified * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'compiled-in seed model'}
            </div>
          </>
        ) : (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: MUT }}>No ML model on this DU</span>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
        {kpi('DL', mbps(k.dl_bps), 'Mbps')}
        {kpi('UL', mbps(k.ul_bps), 'Mbps')}
        {kpi('UEs', k.ues == null ? '—' : String(k.ues))}
        {bsr && kpi('BSR timer', k.bsr_timer_ms == null ? '—' : String(k.bsr_timer_ms), 'ms')}
        {bsr && kpi('Buffer', sum('bsr') == null ? '—' : String(sum('bsr')), 'B')}
        {bsr && kpi('SRs', sum('sr_count') == null ? '—' : String(sum('sr_count')))}
      </div>
      <div style={{ ...box, padding: '4px 7px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: cols, fontSize: 9.5, color: palette.greyTeal, fontWeight: 700, textTransform: 'uppercase' }}>
          <span>UE</span><span>CQI</span><span>MCS</span><span>BLER</span><span>{bsr ? 'BSR' : 'SNR'}</span>
        </div>
        {ues.length === 0 && <div style={{ fontSize: 11, color: MUT }}>no UE attached</div>}
        {ues.slice(0, 3).map((u) => (
          <div key={u.rnti} style={{ display: 'grid', gridTemplateColumns: cols, fontSize: 11, fontWeight: 700, color: stale ? palette.greyTeal : INK, fontFamily: font.mono }}>
            <span>{u.rnti.replace('0x', '')}</span><span>{na(u.cqi)}</span><span>{na(u.dl_mcs)}/{na(u.ul_mcs)}</span>
            <span>{na(u.dl_bler)}</span><span>{bsr ? na(u.bsr) : na(u.snr_db)}</span>
          </div>
        ))}
        {ues.length > 3 && <div style={{ fontSize: 10, color: MUT }}>+{ues.length - 3} more</div>}
      </div>
      {stale && (
        <div style={{ fontSize: 9.5, color: palette.rose, fontWeight: 700 }}>
          {ml.log_age_s == null ? 'no metrics yet' : !k.time ? 'no metrics in log' : `last update ${ago(ml.log_age_s)} ago`}
        </div>
      )}
    </div>
  )
}

function withUes(t: Topo, ml: MlSummary | null): Topo {
  const ues = ml?.kpis?.per_ue ?? []
  if (!ues.length || !ml?.kpis?.time || (ml.log_age_s ?? 99) > 15) return t
  return {
    ...t, nodes: t.nodes.map((n) => (['phone', 'ue', 'ues'].includes(n.kind) && n.col === 'ue'
      ? { ...n, label: `${n.label.replace(' (not started)', '')} · ${ues.length} attached`, attached: true,
          meta: { ...n.meta, ...Object.fromEntries(ues.map((u) => [`RNTI ${u.rnti}`,
            `CQI ${u.cqi ?? '—'} · MCS ${u.dl_mcs ?? '—'}/${u.ul_mcs ?? '—'} · UL ${u.ul_brate ?? '—'}`])) } }
      : n)),
  }
}

async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path, { headers: authHeader() })
  if (!r.ok) throw new Error(`${r.status}`)
  return r.json()
}

export function ScreenTopology() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [all, setAll] = useState<Topo[]>([])
  const [groups, setGroups] = useState<string[]>([])
  const [state, setState] = useState<Record<string, 'up' | 'down'>>({})
  const [hover, setHover] = useState<{ n: Placed; x: number; y: number } | null>(null)
  const wrap = useRef<HTMLDivElement>(null)
  const sel = params.get('stack') || ''

  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let live = true
    const tick = () => getJSON<{ groups: string[]; stacks: Topo[] }>('/api/deploy/topology')
      .then((r) => { if (live) { setAll(r.stacks); setGroups(r.groups); setLoaded(true) } }).catch(() => {})
    tick()
    const iv = setInterval(tick, 5000)
    return () => { live = false; clearInterval(iv) }
  }, [])
  const running = all.filter((x) => x.running)
  const t = running.find((x) => x.stack === sel) ?? (!sel && running.length === 1 ? running[0] : undefined)
  const shown = t?.stack ?? ''

  useEffect(() => {
    if (!shown) return
    let live = true
    const tick = () => getJSON<{ components: { name: string; state: 'up' | 'down' }[] }>(`/api/deploy/stacks/${shown}/status`)
      .then((r) => live && setState(Object.fromEntries(r.components.map((c) => [c.name, c.state])))).catch(() => {})
    tick()
    const iv = setInterval(tick, 5000)
    return () => { live = false; clearInterval(iv) }
  }, [shown])

  const [ml, setMl] = useState<MlSummary | null>(null)
  const [servers, setServers] = useState<{ primary: string; byTarget: Record<string, string> }>({ primary: '', byTarget: {} })
  useEffect(() => {
    hostsApi<{ primary: Host; hosts: Host[] }>('').then((r) => setServers({
      primary: r.primary.nickname, byTarget: Object.fromEntries(r.hosts.map((h) => [target(h), h.nickname])) })).catch(() => {})
  }, [])
  const named = (tt: Topo): Topo => ({ ...tt, nodes: tt.nodes.map((n) => (n.meta.host
    ? { ...n, meta: { ...n.meta, host: servers.byTarget[n.meta.host] ?? n.meta.host } } : n)) })
  const serversOf = (tt: Topo) => {
    const set = new Set<string>()
    tt.nodes.forEach((n) => { if (n.component) set.add(n.meta.host ? (servers.byTarget[n.meta.host] ?? n.meta.host) : servers.primary) })
    return [...set].filter(Boolean)
  }
  const [states, setStates] = useState<Record<string, Record<string, 'up' | 'down'>>>({})
  const runningKey = running.map((x) => x.stack).join(',')
  useEffect(() => {
    if (shown || !runningKey) return
    let live = true
    const tick = () => Promise.all(runningKey.split(',').map((st) =>
      getJSON<{ components: { name: string; state: 'up' | 'down' }[] }>(`/api/deploy/stacks/${st}/status`)
        .then((r) => [st, Object.fromEntries(r.components.map((c) => [c.name, c.state]))] as const).catch(() => null)))
      .then((xs) => live && setStates(Object.fromEntries(xs.filter(Boolean) as [string, Record<string, 'up' | 'down'>][])))
    tick()
    const iv = setInterval(tick, 5000)
    return () => { live = false; clearInterval(iv) }
  }, [shown, runningKey])
  const hasDu = !!t?.nodes.some((n) => n.component === 'ocudu')
  useEffect(() => {
    setMl(null)
    if (!shown || !hasDu) return
    let live = true
    const tick = () => getJSON<MlSummary>(`/api/deploy/stacks/${shown}/ml`).then((r) => live && setMl(r)).catch(() => {})
    tick()
    const iv = setInterval(tick, 3000)
    return () => { live = false; clearInterval(iv) }
  }, [shown, hasDu])
  const [view, setView] = useState<'topology' | 'data'>('topology')

  const pick = (n: Placed) => {
    const q = new URLSearchParams({ stack: shown })
    if (n.component) { q.set('tab', 'components'); q.set('component', n.component) }
    nav(`/deployments?${q}`)
  }
  const onHover = (n: Placed | null, e?: React.MouseEvent) => {
    if (!n || !e || !wrap.current) return setHover(null)
    const b = wrap.current.getBoundingClientRect()
    setHover({ n, x: e.clientX - b.left, y: e.clientY - b.top })
  }

  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <PageHeader title="Network Topology" />

      {loaded && !running.length && (
        <Card pad={28} style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: INK }}>No stack is running</div>
          <button onClick={() => nav('/deployments')} style={{ ...pill(true), padding: '9px 16px', marginTop: 16 }}>Go to Deployments</button>
        </Card>
      )}

      {running.length > 1 && (
      <Card pad={14}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
          <button onClick={() => setParams({})} style={pill(!shown)}>All running</button>
          {groups.map((g) => {
            const inG = running.filter((x) => x.group === g)
            if (!inG.length) return null
            return (
              <div key={g} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, letterSpacing: '.14em', textTransform: 'uppercase', color: palette.greyTeal, fontWeight: 700 }}>{g}</span>
                {inG.map((x) => (
                  <button key={x.stack} onClick={() => setParams({ stack: x.stack })} style={pill(x.stack === shown)}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#0F8A5F', marginRight: 6, display: 'inline-block' }} />
                    {x.stack}
                  </button>
                ))}
              </div>
            )
          })}
        </div>
      </Card>
      )}

      {t ? (
        <Card pad={22}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 23, fontWeight: 800, letterSpacing: '-.4px', fontFamily: font.label }}>{t.stack}</span>
            <span style={{ fontSize: 12, fontWeight: 700, color: palette.rose, background: 'rgba(216,105,147,.10)', padding: '4px 10px', borderRadius: 999 }}>{t.group}</span>
            {t.running ? <StatusPill label="running" fg="#0F8A5F" bg="rgba(15,138,95,.12)" /> : <StatusPill label="stopped" fg={palette.greyTeal} bg="rgba(109,142,153,.14)" />}
            {serversOf(t).map((sv) => (
              <span key={sv} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, fontWeight: 700, color: palette.navy,
                                      background: 'rgba(96,147,186,.14)', padding: '4px 10px', borderRadius: 999 }}>
                <Icon.servers size={13} />{sv}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 14, alignItems: 'center' }}>
              {t.doc && <a href={t.doc} target="_blank" rel="noreferrer" style={{ color: palette.teal }}>Tutorial ↗</a>}
              <button onClick={() => nav(`/deployments?stack=${t.stack}`)} style={{ ...pill(true), padding: '8px 14px' }}>Open in Deployments</button>
            </span>
          </div>
          {hasDu && (
            <div style={{ display: 'flex', gap: 6, marginTop: 16 }}>
              {(['topology', 'data'] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} style={tab(view === v)}>
                  {v === 'topology' ? 'Topology' : `Training data${ml ? ` · ${ml.datasets.files}` : ''}`}
                </button>
              ))}
            </div>
          )}
          {view === 'data' && hasDu ? <TrainingData stack={t.stack} /> : (
            <>
              <div ref={wrap} style={{ position: 'relative', marginTop: 14, background: '#fff', border: `1px solid ${LINE}`, borderRadius: 14, padding: '10px 6px', overflowX: 'auto' }}>
                <Diagram t={withUes(named(t), ml)} primary={servers.primary} state={state} onHover={onHover} onPick={pick} ml={ml} />
                {hover && <HoverCard n={hover.n} t={t} state={state} x={hover.x} y={hover.y} />}
              </div>
            </>
          )}
        </Card>
      ) : running.length > 1 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
          {running.map((x) => (
            <Card key={x.stack} pad={16} style={{ cursor: 'pointer' }}>
              <div onClick={() => setParams({ stack: x.stack })}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: font.label, fontWeight: 700, fontSize: 14 }}>{x.stack}</span>
                  <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#0F8A5F' }} />
                  <span style={{ marginLeft: 'auto', fontSize: 11.5, fontWeight: 700, color: palette.rose }}>{x.group}</span>
                </div>
                <Diagram t={x} compact state={states[x.stack] ?? {}} />
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

function HoverCard({ n, t, state, x, y }: { n: Placed; t: Topo; state: Record<string, string>; x: number; y: number }) {
  const links = t.edges.filter((e) => e.from === n.id || e.to === n.id)
  const name = (id: string) => t.nodes.find((m) => m.id === id)?.label ?? id
  const st = n.component ? state[n.component] : undefined
  return (
    <div style={{ position: 'absolute', left: x + 18, top: y + 12, width: 300, zIndex: 5, pointerEvents: 'none',
                  background: '#fff', border: `1px solid ${LINE}`, borderRadius: 12, padding: '12px 14px',
                  boxShadow: '0 18px 40px -18px rgba(39,85,120,.45)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontWeight: 800, fontSize: 14.5, color: INK }}>{n.label}</span>
        {st && <span style={{ marginLeft: 'auto', fontSize: 12, fontWeight: 700, color: st === 'up' ? '#0F8A5F' : palette.greyTeal }}>{st}</span>}
      </div>
      <div style={{ fontSize: 12, color: palette.greyTeal, marginTop: 2 }}>
        {KIND_LABEL[n.kind] ?? n.kind}
      </div>
      <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 10, rowGap: 3, fontSize: 12.5 }}>
        {Object.entries(n.meta).map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: MUT }}>{k}</span>
            <span style={{ color: INK, fontFamily: font.mono, fontSize: 11.5, wordBreak: 'break-all' }}>{v}</span>
          </div>
        ))}
      </div>
      {!!links.length && (
        <div style={{ marginTop: 8, borderTop: `1px solid ${LINE}`, paddingTop: 7, fontSize: 12, color: MUT }}>
          {links.map((e, i) => (
            <div key={i}>{e.label} <span style={{ color: palette.greyTeal }}>{e.both ? '↔' : e.from === n.id ? '→' : '←'}</span> {name(e.from === n.id ? e.to : e.from)}</div>
          ))}
        </div>
      )}
    </div>
  )
}

const pill = (on: boolean): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: font.label,
  color: on ? '#fff' : INK, background: on ? palette.teal : '#F3F7F8', border: `1px solid ${on ? palette.teal : LINE}`,
})

const tab = (on: boolean): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 9, fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  color: on ? palette.navy : MUT, background: on ? 'rgba(50,121,133,.10)' : 'transparent',
  border: `1px solid ${on ? 'rgba(50,121,133,.40)' : 'transparent'}`,
})

interface Dataset {
  id: string; where: string; name: string; rel: string; feature: string | null
  rows: number; columns: string[]; bytes: number; modified: number; train: string
}

function TrainingData({ stack }: { stack: string }) {
  const [list, setList] = useState<Dataset[] | null>(null)
  const [feats, setFeats] = useState<MlFeature[]>([])
  const [pickId, setPickId] = useState('')
  const [pv, setPv] = useState<{ columns: string[]; head: string[][]; tail: string[][] } | null>(null)
  useEffect(() => {
    let live = true
    const tick = () => getJSON<{ datasets: Dataset[]; features: MlFeature[] }>(`/api/deploy/stacks/${stack}/datasets`)
      .then((r) => { if (live) { setList(r.datasets); setFeats(r.features) } }).catch(() => live && setList([]))
    tick()
    const iv = setInterval(tick, 10000)
    return () => { live = false; clearInterval(iv) }
  }, [stack])
  useEffect(() => {
    if (!pickId) return setPv(null)
    getJSON<{ columns: string[]; head: string[][]; tail: string[][] }>(
      `/api/deploy/stacks/${stack}/datasets/preview?id=${encodeURIComponent(pickId)}&n=12`).then(setPv).catch(() => setPv(null))
  }, [stack, pickId])
  const sel = list?.find((d) => d.id === pickId)
  const [trainMsg, setTrainMsg] = useState('')
  const train = async () => {
    const r = await fetch(`/api/deploy/stacks/${stack}/train`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: '{}' })
    setTrainMsg(r.ok ? 'Training started' : ((await r.json().catch(() => ({}))).detail || `failed (${r.status})`))
  }
  const download = async (d: Dataset) => {
    const r = await fetch(`/api/deploy/stacks/${stack}/datasets/download?id=${encodeURIComponent(d.id)}`, { headers: authHeader() })
    if (!r.ok) return
    const url = URL.createObjectURL(await r.blob())
    const a = document.createElement('a'); a.href = url; a.download = `${stack}-${d.name}`; a.click()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }
  if (list === null) return <div style={{ color: MUT, marginTop: 16 }}>Loading…</div>
  const cell: React.CSSProperties = { padding: '8px 10px', borderBottom: `1px solid ${LINE}`, fontSize: 13, textAlign: 'left' }
  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        {feats.map((f) => (
          <div key={f.feature} style={{ padding: '10px 14px', borderRadius: 12, border: `1px solid ${LINE}`, background: '#fff', borderLeft: `3px solid ${palette.rose}` }}>
            <div style={{ fontWeight: 800, fontSize: 13.5 }}>{f.label} <span style={{ fontSize: 11, fontWeight: 800, marginLeft: 6, padding: '1px 7px', borderRadius: 999, color: MODE[f.mode].fg, background: MODE[f.mode].bg }}>{f.mode}</span></div>
            <div style={{ fontSize: 12, color: MUT, marginTop: 3, fontFamily: font.mono }}>{f.model}</div>
          </div>
        ))}
        {!feats.length && <div style={{ color: MUT, fontSize: 13.5 }}>No ML feature on this DU.</div>}
        {!!feats.length && (
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {trainMsg && <span style={{ fontSize: 12.5, color: MUT }}>{trainMsg}</span>}
            <button onClick={train} style={{ ...pill(true), padding: '8px 14px' }}>Train model</button>
          </span>
        )}
      </div>
      {!list.length ? (
        <div style={{ color: MUT, fontSize: 13.5 }}>No training data yet.</div>
      ) : (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, overflow: 'hidden', background: '#fff' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: palette.greyTeal }}>
              {['Dataset', 'Feature', 'Rows', 'Columns', 'Size', 'Written', 'Source'].map((h) => <th key={h} style={{ ...cell, fontWeight: 700, fontSize: 12 }}>{h}</th>)}
            </tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} onClick={() => setPickId(d.id === pickId ? '' : d.id)}
                  style={{ cursor: 'pointer', background: d.id === pickId ? 'rgba(50,121,133,.08)' : undefined }}>
                  <td style={{ ...cell, fontFamily: font.label, fontSize: 12.5 }}>{d.name}</td>
                  <td style={cell}>{feats.find((f) => f.feature === d.feature)?.label ?? (d.feature || 'report')}</td>
                  <td style={cell}>{d.rows.toLocaleString()}</td>
                  <td style={cell}>{d.columns.length}</td>
                  <td style={cell}>{d.bytes < 1024 ? `${d.bytes} B` : `${(d.bytes / 1024).toFixed(1)} KB`}</td>
                  <td style={{ ...cell, color: MUT }}>{ago(Date.now() / 1000 - d.modified)} ago</td>
                  <td style={{ ...cell, color: MUT }}>{d.where === 'tree' ? 'DU logger' : 'collected run'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sel && (
        <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, background: '#fff', padding: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, fontFamily: font.label, fontSize: 13 }}>{sel.name}</span>
            <span style={{ color: MUT, fontSize: 12.5 }}>{sel.rows.toLocaleString()} rows · {sel.columns.length} columns</span>
            <button onClick={() => download(sel)} style={{ ...tab(true), marginLeft: 'auto' }}>↓ Download CSV</button>
          </div>
          {pv && (
            <div style={{ marginTop: 12, overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', fontFamily: font.mono, fontSize: 11.5 }}>
                <thead><tr>{pv.columns.map((c) => <th key={c} style={{ ...cell, fontSize: 11, color: palette.navy, whiteSpace: 'nowrap', position: 'sticky', top: 0, background: '#F3F7F8' }}>{c}</th>)}</tr></thead>
                <tbody>
                  {pv.head.map((r, i) => <tr key={`h${i}`}>{r.map((v, j) => <td key={j} style={{ ...cell, fontSize: 11.5, whiteSpace: 'nowrap' }}>{v}</td>)}</tr>)}
                  {!!pv.tail.length && <tr><td colSpan={pv.columns.length} style={{ ...cell, color: MUT, textAlign: 'center' }}>⋯</td></tr>}
                  {pv.tail.map((r, i) => <tr key={`t${i}`}>{r.map((v, j) => <td key={j} style={{ ...cell, fontSize: 11.5, whiteSpace: 'nowrap' }}>{v}</td>)}</tr>)}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
