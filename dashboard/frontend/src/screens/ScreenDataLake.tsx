import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { Card, PageHeader } from '../components/ui'
import { font, palette } from '../styles/theme'
import { OUTCOME, dur, lakeApi, when } from './ScreenRunHistory'

export interface LakeFile {
  path: string; name: string; bytes: number; mtime: number; stack: string; run: string | null
  kind: 'csv' | 'log' | 'other'; rows?: number; columns?: number; feature?: string | null
}
interface Run {
  id: string; stack: string; started: number; ended: number | null; outcome: string; duration_s: number; user: string
  hosts: Record<string, string>; settings: Record<string, string>; ocudu_branch?: string; ocudu_src?: string; files: LakeFile[]
}
interface StackSum { stack: string; group: string; runs: number; csvs: number; rows: number; bytes: number; last: number }

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', WELL = '#F3F7F8'
export const size = (b: number) => (b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(1)} KB` : b < 1 << 30 ? `${(b / (1 << 20)).toFixed(1)} MB` : `${(b / (1 << 30)).toFixed(2)} GB`)
export const SELECT_KEY = 'studio.selection'

export async function download(f: { path: string; name: string }) {
  const r = await fetch(`/api/lake/download?path=${encodeURIComponent(f.path)}`, { headers: authHeader() })
  if (!r.ok) return
  const url = URL.createObjectURL(await r.blob())
  const a = document.createElement('a'); a.href = url; a.download = f.name; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export function Preview({ f, onClose }: { f: LakeFile; onClose: () => void }) {
  const [pv, setPv] = useState<{ kind: string; columns?: string[]; head?: string[][]; tail?: string[][]; text?: string } | null>(null)
  useEffect(() => { lakeApi<typeof pv>(`/preview?path=${encodeURIComponent(f.path)}`).then(setPv).catch(() => setPv({ kind: 'text', text: 'unreadable' })) }, [f.path])
  const cell: React.CSSProperties = { padding: '5px 9px', borderBottom: `1px solid ${LINE}`, fontSize: 11.5, whiteSpace: 'nowrap', fontFamily: font.mono }
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,24,32,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(1200px, 95vw)', height: '80vh', background: '#fff', borderRadius: 16, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: `1px solid ${LINE}` }}>
          <span style={{ fontWeight: 800, fontFamily: font.label, fontSize: 13.5 }}>{f.name}</span>
          <span style={{ fontSize: 12.5, color: MUT }}>{f.rows != null ? `${f.rows.toLocaleString()} rows · ${f.columns} columns · ` : ''}{size(f.bytes)}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={() => download(f)} style={btn()}>Download</button>
            <button onClick={onClose} style={btn()}>Close</button>
          </span>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {!pv ? <div style={{ padding: 16, color: MUT }}>Loading…</div> : pv.kind === 'csv' ? (
            <table style={{ borderCollapse: 'collapse' }}>
              <thead><tr>{pv.columns!.map((c) => <th key={c} style={{ ...cell, position: 'sticky', top: 0, background: WELL, color: palette.navy, textAlign: 'left' }}>{c}</th>)}</tr></thead>
              <tbody>
                {pv.head!.map((r, i) => <tr key={`h${i}`}>{r.map((v, j) => <td key={j} style={cell}>{v}</td>)}</tr>)}
                {!!pv.tail?.length && <tr><td colSpan={pv.columns!.length} style={{ ...cell, color: MUT, textAlign: 'center' }}>⋯</td></tr>}
                {pv.tail?.map((r, i) => <tr key={`t${i}`}>{r.map((v, j) => <td key={j} style={cell}>{v}</td>)}</tr>)}
              </tbody>
            </table>
          ) : <pre style={{ margin: 0, padding: 16, fontFamily: font.mono, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: INK }}>{pv.text}</pre>}
        </div>
      </div>
    </div>,
    document.body,
  )
}

const dateInp: React.CSSProperties = { padding: '6px 9px', borderRadius: 8, border: `1px solid ${LINE}`, fontSize: 12.5, fontFamily: font.mono, background: '#fff', color: INK }

const btn = (primary = false): React.CSSProperties => ({
  padding: '6px 12px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  color: primary ? '#fff' : INK, background: primary ? palette.teal : '#fff', border: `1px solid ${primary ? palette.teal : LINE}`,
})

function FileTable({ files, picked, onPick, onOpen }: { files: LakeFile[]; picked: Set<string>; onPick: (p: string) => void; onOpen: (f: LakeFile) => void }) {
  const td: React.CSSProperties = { padding: '7px 10px', borderTop: `1px solid ${LINE}`, fontSize: 12.5 }
  if (!files.length) return <div style={{ fontSize: 12.5, color: MUT, padding: '6px 2px' }}>No files.</div>
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <tbody>
        {files.map((f) => (
          <tr key={f.path}>
            <td style={{ ...td, width: 28 }}>{f.kind === 'csv' && <input type="checkbox" checked={picked.has(f.path)} onChange={() => onPick(f.path)} />}</td>
            <td style={{ ...td, width: 46 }}>
              <span style={{ fontSize: 10.5, fontWeight: 800, padding: '2px 7px', borderRadius: 6, color: f.kind === 'csv' ? palette.teal : f.kind === 'log' ? palette.navy : MUT,
                             background: f.kind === 'csv' ? 'rgba(50,121,133,.10)' : f.kind === 'log' ? 'rgba(96,147,186,.14)' : WELL }}>{f.kind.toUpperCase()}</span>
            </td>
            <td style={{ ...td, fontFamily: font.label, cursor: 'pointer', color: INK }} onClick={() => onOpen(f)}>{f.name}</td>
            <td style={{ ...td, color: MUT }}>{f.feature ?? ''}</td>
            <td style={{ ...td, color: MUT, textAlign: 'right' }}>{f.rows != null ? `${f.rows.toLocaleString()} rows` : ''}</td>
            <td style={{ ...td, color: MUT, textAlign: 'right', whiteSpace: 'nowrap' }}>{size(f.bytes)}</td>
            <td style={{ ...td, textAlign: 'right', width: 150 }}>
              <span style={{ display: 'inline-flex', gap: 6 }}>
                <button onClick={() => onOpen(f)} style={btn()}>View</button>
                <button onClick={() => download(f)} style={btn()}>↓</button>
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function ScreenDataLake() {
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [stacks, setStacks] = useState<StackSum[] | null>(null)
  const [data, setData] = useState<{ stack: string; feature: string | null; runs: Run[]; loose: LakeFile[] } | null>(null)
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [view, setView] = useState<LakeFile | null>(null)
  const [err, setErr] = useState('')
  const [kind, setKind] = useState<'all' | 'csv' | 'log' | 'other'>('all')
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [q, setQ] = useState('')
  const t0 = from ? new Date(`${from}T00:00:00`).getTime() / 1000 : -Infinity
  const t1 = to ? new Date(`${to}T23:59:59`).getTime() / 1000 : Infinity
  const keep = (f: LakeFile) => (kind === 'all' || f.kind === kind) && f.mtime >= t0 && f.mtime <= t1
    && (!q || f.name.toLowerCase().includes(q.toLowerCase()))
  const filtering = kind !== 'all' || !!from || !!to || !!q
  const stack = params.get('stack') || stacks?.[0]?.stack || ''

  useEffect(() => { lakeApi<{ stacks: StackSum[] }>('/overview').then((r) => setStacks(r.stacks)).catch((e) => setErr(e.message)) }, [])
  const load = useCallback(() => {
    if (!stack) return
    lakeApi<typeof data>(`/stack/${stack}`).then((r) => {
      setData(r)
      const run = params.get('run')
      setOpen(new Set(run ? [run] : r!.runs.slice(0, 1).map((x) => x.id)))
    }).catch((e) => setErr(e.message))
  }, [stack]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setData(null); setPicked(new Set()); load() }, [load])

  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })
  const toStudio = () => { try { sessionStorage.setItem(SELECT_KEY, JSON.stringify([...picked])) } catch {  } nav('/studio') }
  const removeRun = async (r: Run) => {
    if (!confirm(`Delete run ${r.id} and its files?`)) return
    try { await lakeApi(`/runs/${r.stack}/${r.id}`, { method: 'DELETE' }); load() } catch (e) { setErr((e as Error).message) }
  }
  const allFiles = [...(data?.runs.flatMap((r) => r.files) ?? []), ...(data?.loose ?? [])]
  const runs = (data?.runs ?? []).map((r) => ({ ...r, shown: r.files.filter(keep) }))
    .filter((r) => (r.shown.length > 0) || (!filtering) || (kind === 'all' && !q && r.started >= t0 && r.started <= t1))
  const looseShown = (data?.loose ?? []).filter(keep)
  const matches = runs.reduce((a, r) => a + r.shown.length, 0) + looseShown.length
  const pickedRows = allFiles.filter((f) => picked.has(f.path)).reduce((a, f) => a + (f.rows ?? 0), 0)

  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Data Lake" />
      {err && <Card pad={12} style={{ color: '#B3272C', fontSize: 13 }}>{err}</Card>}
      <div style={{ display: 'grid', gridTemplateColumns: '270px minmax(0, 1fr)', gap: 18, alignItems: 'start' }}>
        <Card pad={10} style={{ position: 'sticky', top: 12 }}>
          {stacks && !stacks.length && <div style={{ padding: 10, color: MUT, fontSize: 13 }}>No data</div>}
          {stacks?.map((s) => {
            const on = s.stack === stack
            return (
              <button key={s.stack} onClick={() => setParams({ stack: s.stack })}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '10px 12px', marginBottom: 4, borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                         background: on ? 'rgba(50,121,133,.10)' : 'transparent', border: `1px solid ${on ? 'rgba(50,121,133,.40)' : 'transparent'}` }}>
                <div style={{ fontFamily: font.label, fontWeight: 700, fontSize: 13, color: on ? palette.navy : INK }}>{s.stack}</div>
                <div style={{ fontSize: 11.5, color: MUT, marginTop: 3 }}>{s.runs} runs · {s.csvs} CSV · {s.rows.toLocaleString()} rows · {size(s.bytes)}</div>
              </button>
            )
          })}
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
          {data && (
            <Card pad={10} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', background: WELL, borderRadius: 9, padding: 3, gap: 2 }}>
                {(['all', 'csv', 'log', 'other'] as const).map((k) => (
                  <button key={k} onClick={() => setKind(k)}
                    style={{ padding: '5px 12px', borderRadius: 7, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 12.5,
                             background: kind === k ? '#fff' : 'transparent', color: kind === k ? INK : MUT, boxShadow: kind === k ? '0 1px 3px rgba(0,0,0,.12)' : 'none' }}>
                    {k === 'all' ? 'All' : k === 'csv' ? 'CSV' : k === 'log' ? 'Logs' : 'Other'}
                    <span style={{ marginLeft: 5, opacity: 0.6 }}>{k === 'all' ? allFiles.length : allFiles.filter((f) => f.kind === k).length}</span>
                  </button>
                ))}
              </div>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: MUT }}>
                From <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} style={dateInp} />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 600, color: MUT }}>
                To <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} style={dateInp} />
              </label>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" style={{ ...dateInp, flex: 1, minWidth: 160, fontFamily: 'inherit' }} />
              {filtering && (
                <>
                  <span style={{ fontSize: 12.5, color: MUT }}>{matches} match{matches === 1 ? '' : 'es'}</span>
                  <button onClick={() => { setKind('all'); setFrom(''); setTo(''); setQ('') }} style={btn()}>Reset</button>
                </>
              )}
            </Card>
          )}
          {picked.size > 0 && (
            <Card pad={12} style={{ display: 'flex', alignItems: 'center', gap: 12, position: 'sticky', top: 12, zIndex: 2, borderColor: 'rgba(50,121,133,.45)' }}>
              <span style={{ fontWeight: 800 }}>{picked.size} CSV selected</span>
              <span style={{ color: MUT, fontSize: 13 }}>{pickedRows.toLocaleString()} rows</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button onClick={() => setPicked(new Set())} style={btn()}>Clear</button>
                <button onClick={toStudio} style={btn(true)}>Train →</button>
              </span>
            </Card>
          )}
          {!data ? <div style={{ color: MUT }}>{stack ? 'Loading…' : ''}</div> : (
            <>
              {!data.runs.length && <Card pad={14} style={{ color: MUT, fontSize: 13 }}>No runs</Card>}
              {filtering && !matches && <Card pad={14} style={{ color: MUT, fontSize: 13 }}>No matches</Card>}
              {runs.map((r) => {
                const isOpen = open.has(r.id) || (filtering && r.shown.length > 0)
                const o = OUTCOME[r.outcome] ?? OUTCOME.ended
                const csv = r.files.filter((f) => f.kind === 'csv')
                return (
                  <Card key={r.id} pad={0} style={{ overflow: 'hidden', borderColor: params.get('run') === r.id ? 'rgba(50,121,133,.55)' : LINE }}>
                    <div onClick={() => setOpen((s) => { const n = new Set(s); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n })}
                      style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', cursor: 'pointer' }}>
                      <span style={{ color: MUT, width: 12 }}>{isOpen ? '▾' : '▸'}</span>
                      <span style={{ fontWeight: 800 }}>{when(r.started)}</span>
                      <span style={{ fontSize: 11.5, fontWeight: 800, padding: '3px 9px', borderRadius: 999, color: o.fg, background: o.bg }}>{r.outcome}</span>
                      <span style={{ fontSize: 12.5, color: MUT }}>{dur(r.duration_s)} · {csv.length} CSV · {csv.reduce((a, f) => a + (f.rows ?? 0), 0).toLocaleString()} rows · {r.files.length - csv.length} logs</span>
                      <span style={{ marginLeft: 'auto', fontSize: 12, color: palette.greyTeal, fontFamily: font.label }}>{r.id}</span>
                    </div>
                    {isOpen && (
                      <div style={{ padding: '0 16px 14px' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                          {r.ocudu_branch && <Tag>{`OCUDU · ${r.ocudu_branch}`}</Tag>}
                          {[...new Set(Object.values(r.hosts || {}))].map((h) => <Tag key={h}>{`@ ${h}`}</Tag>)}
                          {Object.entries(r.settings || {}).map(([k, v]) => <Tag key={k} mono>{`${k}=${v.length > 40 ? '…' + v.slice(-38) : v}`}</Tag>)}
                          <span style={{ marginLeft: 'auto' }}><button onClick={() => removeRun(r)} style={{ ...btn(), color: '#B3272C' }}>Delete run</button></span>
                        </div>
                        <FileTable files={r.shown} picked={picked} onPick={toggle} onOpen={setView} />
                      </div>
                    )}
                  </Card>
                )
              })}
              {!!looseShown.length && (
                <Card pad={14}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Earlier data</div>
                  <FileTable files={looseShown} picked={picked} onPick={toggle} onOpen={setView} />
                </Card>
              )}
            </>
          )}
        </div>
      </div>
      {view && <Preview f={view} onClose={() => setView(null)} />}
    </div>
  )
}

function Tag({ children, mono }: { children: string; mono?: boolean }) {
  return <span style={{ fontSize: 11.5, fontWeight: 600, padding: '3px 9px', borderRadius: 999, background: WELL, border: `1px solid ${LINE}`,
                        color: INK, fontFamily: mono ? font.mono : undefined }}>{children}</span>
}
