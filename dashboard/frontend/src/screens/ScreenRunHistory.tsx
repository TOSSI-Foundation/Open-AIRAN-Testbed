import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { Card, PageHeader } from '../components/ui'
import { font, palette } from '../styles/theme'

export interface RunRow {
  type: 'stack' | 'simulation'; id: string; stack: string; started: number; ended: number | null; outcome: string
  duration_s: number; csvs: number; rows: number; logs: number; user: string | null; hosts: Record<string, string>
}

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA'
export const OUTCOME: Record<string, { fg: string; bg: string }> = {
  running: { fg: palette.teal, bg: 'rgba(50,121,133,.12)' }, stopped: { fg: '#0F8A5F', bg: 'rgba(15,138,95,.10)' },
  complete: { fg: '#0F8A5F', bg: 'rgba(15,138,95,.10)' }, ended: { fg: MUT, bg: '#EEF3F4' },
  failed: { fg: '#B3272C', bg: 'rgba(179,39,44,.08)' }, superseded: { fg: MUT, bg: '#EEF3F4' },
}
export async function lakeApi<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/lake${path}`, { ...init, headers: { ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...authHeader() } })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`)
  return r.json()
}
export const dur = (s: number) => (s < 60 ? `${s}s` : s < 3600 ? `${(s / 60) | 0}m ${s % 60}s` : `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m`)
export const when = (t: number) => new Date(t * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

export function ScreenRunHistory() {
  const nav = useNavigate()
  const [runs, setRuns] = useState<RunRow[] | null>(null)
  const [type, setType] = useState<'all' | 'stack' | 'simulation'>('all')
  const [stack, setStack] = useState('')
  useEffect(() => { lakeApi<{ runs: RunRow[] }>('/runs').then((r) => setRuns(r.runs)).catch(() => setRuns([])) }, [])
  const stacks = useMemo(() => [...new Set((runs ?? []).filter((r) => r.type === 'stack').map((r) => r.stack))].sort(), [runs])
  const shown = (runs ?? []).filter((r) => (type === 'all' || r.type === type) && (!stack || r.stack === stack))
  const th: React.CSSProperties = { textAlign: 'left', padding: '10px 12px', fontSize: 12, fontWeight: 700, color: palette.greyTeal, borderBottom: `1px solid ${LINE}` }
  const td: React.CSSProperties = { padding: '10px 12px', fontSize: 13, borderBottom: `1px solid ${LINE}`, color: INK }
  const pill = (on: boolean): React.CSSProperties => ({ padding: '6px 13px', borderRadius: 999, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
    color: on ? '#fff' : INK, background: on ? palette.teal : '#fff', border: `1px solid ${on ? palette.teal : LINE}` })
  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Runs" />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {(['all', 'stack', 'simulation'] as const).map((t) => (
          <button key={t} onClick={() => setType(t)} style={pill(type === t)}>
            {t === 'all' ? 'All' : t === 'stack' ? 'Stacks' : 'Simulation'} <span style={{ opacity: 0.7 }}>{(runs ?? []).filter((r) => t === 'all' || r.type === t).length}</span>
          </button>
        ))}
        <select value={stack} onChange={(e) => setStack(e.target.value)}
          style={{ marginLeft: 'auto', padding: '7px 10px', borderRadius: 9, border: `1px solid ${LINE}`, fontFamily: font.mono, fontSize: 12.5, background: '#fff' }}>
          <option value="">every stack</option>
          {stacks.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <Card pad={0} style={{ overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead><tr>{['Started', 'Run', 'Type', 'Duration', 'Outcome', 'Servers', 'Data', 'Logs'].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {runs === null && <tr><td style={{ ...td, color: MUT }} colSpan={8}>Loading…</td></tr>}
            {runs && !shown.length && <tr><td style={{ ...td, color: MUT }} colSpan={8}>No runs</td></tr>}
            {shown.map((r) => {
              const o = OUTCOME[r.outcome] ?? OUTCOME.ended
              const servers = [...new Set(Object.values(r.hosts || {}))]
              return (
                <tr key={`${r.type}-${r.stack}-${r.id}`} style={{ cursor: 'pointer' }}
                  onClick={() => nav(r.type === 'stack' ? `/lake?stack=${encodeURIComponent(r.stack)}&run=${r.id}` : `/run/${r.id}`)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = '#F7FAFB')} onMouseLeave={(e) => (e.currentTarget.style.background = '')}>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{when(r.started)}</td>
                  <td style={{ ...td, fontFamily: r.type === 'stack' ? font.label : undefined, fontWeight: 700 }}>{r.stack}</td>
                  <td style={td}><span style={{ fontSize: 11.5, fontWeight: 700, color: r.type === 'stack' ? palette.navy : palette.rose }}>{r.type === 'stack' ? 'stack' : 'simulation'}</span></td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{dur(r.duration_s)}</td>
                  <td style={td}><span style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: o.fg, background: o.bg }}>{r.outcome}</span></td>
                  <td style={{ ...td, color: MUT, fontSize: 12.5 }}>{servers.length ? servers.join(', ') : r.type === 'stack' ? 'primary' : '—'}</td>
                  <td style={{ ...td, whiteSpace: 'nowrap' }}>{r.csvs ? `${r.csvs} CSV · ${r.rows.toLocaleString()} rows` : <span style={{ color: MUT }}>—</span>}</td>
                  <td style={{ ...td, color: MUT }}>{r.logs || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
