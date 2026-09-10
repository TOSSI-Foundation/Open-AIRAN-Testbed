import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { AgentChat, call } from '../components/AgentDock'
import { StudioDock } from '../components/StudioDock'
import { Card, PageHeader } from '../components/ui'
import { font, palette } from '../styles/theme'
import { Preview, SELECT_KEY, size, type LakeFile } from './ScreenDataLake'
import { lakeApi, when } from './ScreenRunHistory'
import { hostsApi, type Host } from './ScreenServers'

interface Model {
  id: string; name: string; stack: string | null; feature?: string | null; source: 'trained' | 'uploaded'; path: string
  exists: boolean; bytes: number; mtime: number | null; in_use_by: string | null; notes?: string; file?: string
}

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', WELL = '#F3F7F8'
const btn = (primary = false): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  color: primary ? '#fff' : INK, background: primary ? palette.teal : '#fff', border: `1px solid ${primary ? palette.teal : LINE}`,
  display: 'inline-flex', alignItems: 'center', gap: 6,
})

function Upload({ stacks, onClose, onDone }: { stacks: string[]; onClose: () => void; onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [name, setName] = useState(''); const [stack, setStack] = useState(''); const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false); const [err, setErr] = useState('')
  const submit = async () => {
    if (!file) return
    setBusy(true); setErr('')
    const fd = new FormData(); fd.append('file', file); fd.append('name', name); fd.append('stack', stack); fd.append('notes', notes)
    try { await lakeApi('/models', { method: 'POST', body: fd }); onDone(); onClose() } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const inp: React.CSSProperties = { padding: '9px 11px', borderRadius: 9, border: `1px solid ${LINE}`, background: WELL, fontSize: 13.5, fontFamily: 'inherit', outline: 'none' }
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,24,32,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(500px, 94vw)', background: '#fff', borderRadius: 16, padding: 22, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>Upload model</div>
        <label style={{ border: `2px dashed ${file ? palette.teal : LINE}`, borderRadius: 12, padding: 18, textAlign: 'center', cursor: 'pointer', color: file ? INK : MUT, fontWeight: 600 }}>
          <input type="file" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); if (f && !name) setName(f.name) }} />
          {file ? `${file.name} · ${size(file.size)}` : 'Choose file'}
        </label>
        <input style={inp} placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <select style={inp} value={stack} onChange={(e) => setStack(e.target.value)}>
          <option value="">Stack</option>
          {stacks.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <textarea style={{ ...inp, resize: 'vertical' }} rows={3} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {err && <div style={{ color: '#B3272C', fontSize: 12.5 }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button onClick={submit} disabled={!file || busy} style={{ ...btn(true), opacity: !file || busy ? 0.5 : 1 }}>{busy ? 'Uploading…' : 'Upload'}</button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ScreenStudio() {
  const [ds, setDs] = useState<LakeFile[] | null>(null)
  const [models, setModels] = useState<{ models: Model[]; stacks: string[] } | null>(null)
  const [servers, setServers] = useState<Host[]>([])
  const [picked, setPicked] = useState<Set<string>>(() => { try { return new Set(JSON.parse(sessionStorage.getItem(SELECT_KEY) || '[]')) } catch { return new Set() } })
  const [stackF, setStackF] = useState(''); const [featF, setFeatF] = useState('')
  const [view, setView] = useState<LakeFile | null>(null)
  const [upload, setUpload] = useState(false)
  const [chatKey, setChatKey] = useState(0)
  const [draft, setDraft] = useState({ text: '', n: 0 })
  const compose = (text: string) => { setMsg(''); setDraft((d) => ({ text: `${text}\n\n`, n: d.n + 1 })); chatRef.current?.scrollIntoView({ behavior: 'smooth' }) }
  type Left = 'datasets' | 'models' | 'benchmarks'
  const [left, setLeftState] = useState<Left>(() => {
    try { const v = localStorage.getItem('studio.left'); return v === 'models' || v === 'benchmarks' ? v : 'datasets' } catch { return 'datasets' }
  })
  const setLeft = (k: Left) => { setLeftState(k); try { localStorage.setItem('studio.left', k) } catch {  } }
  const [bench, setBench] = useState<Bench[] | null>(null)
  const loadBench = useCallback(() => lakeApi<{ benchmarks: Bench[] }>('/benchmarks').then((r) => setBench(r.benchmarks)).catch(() => setBench([])), [])
  useEffect(() => { loadBench(); const t = setInterval(loadBench, 15000); return () => clearInterval(t) }, [loadBench])
  const [msg, setMsg] = useState('')
  const [useFor, setUseFor] = useState<Record<string, string>>({})
  const chatRef = useRef<HTMLDivElement>(null)

  const loadModels = useCallback(() => lakeApi<{ models: Model[]; stacks: string[] }>('/models').then(setModels).catch(() => {}), [])
  useEffect(() => {
    lakeApi<{ datasets: LakeFile[] }>('/datasets').then((r) => setDs(r.datasets)).catch(() => setDs([]))
    loadModels()
    hostsApi<{ primary: Host; hosts: Host[] }>('').then((r) => setServers([r.primary, ...r.hosts])).catch(() => {})
  }, [loadModels])
  useEffect(() => { try { sessionStorage.setItem(SELECT_KEY, JSON.stringify([...picked])) } catch {  } }, [picked])

  const stacks = useMemo(() => [...new Set((ds ?? []).map((d) => d.stack))].sort(), [ds])
  const feats = useMemo(() => [...new Set((ds ?? []).map((d) => d.feature).filter(Boolean) as string[])].sort(), [ds])
  const shown = (ds ?? []).filter((d) => (!stackF || d.stack === stackF) && (!featF || d.feature === featF))
  const sel = (ds ?? []).filter((d) => picked.has(d.path))
  const selStacks = [...new Set(sel.map((d) => d.stack))]
  const rows = sel.reduce((a, d) => a + (d.rows ?? 0), 0)
  const toggle = (p: string) => setPicked((s) => { const n = new Set(s); n.has(p) ? n.delete(p) : n.add(p); return n })

  const train = () => {
    if (selStacks.length !== 1) return
    const st = selStacks[0]
    const text = `Train the ML model for stack ${st} on these ${sel.length} datasets (${rows.toLocaleString()} rows):\n` +
      sel.map((d) => `- ${d.path} (${(d.rows ?? 0).toLocaleString()} rows${d.run ? `, run ${d.run}` : ''})`).join('\n') +
      `\n\nUse train_model with exactly these CSVs. Then check the training result and put the model into service in OCUDU step by step (shadow mode first), asking me before each change.`
    compose(text)
  }
  const ask = async (text: string) => {
    try { await call(`/ml/message`, { method: 'POST', body: JSON.stringify({ text, context: '/studio' }) }); setChatKey((k) => k + 1) }
    catch (e) { setMsg((e as Error).message) }
  }
  const use = async (m: Model) => {
    const st = useFor[m.id] || m.stack || ''
    if (!st) return
    try { await lakeApi(`/models/${m.id}/use`, { method: 'POST', body: JSON.stringify({ stack: st }) }); setMsg(`${m.name} installed for ${st}`); loadModels() }
    catch (e) { setMsg((e as Error).message) }
  }
  const integrate = (m: Model) => {
    const st = useFor[m.id] || m.stack || ''
    const text = `I uploaded my own model "${m.name}" (${m.path}${m.notes ? `; notes: ${m.notes}` : ''})${st ? ` for stack ${st}` : ''}. ` +
      `Check whether its format is what the DU's predictor loads; then integrate it into OCUDU and put it into service step by step (shadow mode first), asking me before each change.`
    compose(text)
  }
  const remove = async (m: Model) => { if (!confirm(`Delete ${m.name}?`)) return; try { await lakeApi(`/models/${m.id}`, { method: 'DELETE' }); loadModels() } catch (e) { setMsg((e as Error).message) } }

  const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontSize: 11.5, fontWeight: 700, color: palette.greyTeal, borderBottom: `1px solid ${LINE}`, position: 'sticky', top: 0, background: '#fff' }
  const td: React.CSSProperties = { padding: '7px 10px', fontSize: 12.5, borderBottom: `1px solid ${LINE}` }
  const filt: React.CSSProperties = { padding: '6px 9px', borderRadius: 8, border: `1px solid ${LINE}`, fontSize: 12.5, fontFamily: font.mono, background: '#fff' }

  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <div style={{ flex: 1, minHeight: 0, padding: '18px 34px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <PageHeader title="AI Studio" actions={
        <span style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setUpload(true)} style={btn(true)}>+ Upload model</button>
        </span>
      } />
      {msg && <Card pad={10} style={{ fontSize: 13, color: INK }}>{msg}</Card>}

      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1.25fr) minmax(380px, 1fr)', gridTemplateRows: 'minmax(0, 1fr)', gap: 18 }}>
        <Card pad={0} style={{ minWidth: 0, minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px 0 6px', borderBottom: `1px solid ${LINE}`, minHeight: 50, flexWrap: 'wrap' }}>
            {(['datasets', 'models', 'benchmarks'] as const).map((k) => (
              <button key={k} onClick={() => setLeft(k)}
                style={{ padding: '14px 12px 12px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', fontSize: 14.5, fontWeight: 800,
                         color: left === k ? INK : MUT, borderBottom: `2.5px solid ${left === k ? palette.teal : 'transparent'}`, marginBottom: -1 }}>
                {k === 'datasets' ? 'Datasets' : k === 'models' ? 'Models' : 'Benchmarks'}
                <span style={{ marginLeft: 6, fontSize: 12, fontWeight: 700, color: MUT }}>{k === 'datasets' ? ds?.length ?? 0 : k === 'models' ? models?.models.length ?? 0 : bench?.length ?? 0}</span>
              </button>
            ))}
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, padding: '6px 0' }}>
              {left === 'datasets' ? (
                <>
                <select value={stackF} onChange={(e) => setStackF(e.target.value)} style={filt}><option value="">every stack</option>{stacks.map((s) => <option key={s}>{s}</option>)}</select>
                <select value={featF} onChange={(e) => setFeatF(e.target.value)} style={filt}><option value="">every feature</option>{feats.map((s) => <option key={s}>{s}</option>)}</select>
                </>
              ) : left === 'models' ? (
                <button onClick={() => setUpload(true)} style={btn()}>+ Upload model</button>
              ) : null}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {left === 'datasets' ? (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead><tr>
                  <th style={{ ...th, width: 30 }}><input type="checkbox" checked={!!shown.length && shown.every((d) => picked.has(d.path))}
                    onChange={(e) => setPicked((s) => { const n = new Set(s); shown.forEach((d) => (e.target.checked ? n.add(d.path) : n.delete(d.path))); return n })} /></th>
                  {['Dataset', 'Stack', 'Run', 'Rows', 'Written'].map((h) => <th key={h} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {ds === null && <tr><td style={{ ...td, color: MUT }} colSpan={6}>Loading…</td></tr>}
                  {ds && !shown.length && <tr><td style={{ ...td, color: MUT }} colSpan={6}>No datasets</td></tr>}
                  {shown.map((d) => (
                    <tr key={d.path} style={{ background: picked.has(d.path) ? 'rgba(50,121,133,.06)' : undefined }}>
                      <td style={td}><input type="checkbox" checked={picked.has(d.path)} onChange={() => toggle(d.path)} /></td>
                      <td style={{ ...td, fontFamily: font.label, fontSize: 12, cursor: 'pointer' }} onClick={() => setView(d)} title={d.path}>{d.name}</td>
                      <td style={{ ...td, fontFamily: font.label, fontSize: 12, whiteSpace: 'nowrap' }}>{d.stack}</td>
                      <td style={{ ...td, color: MUT, fontFamily: font.label, fontSize: 12, whiteSpace: 'nowrap' }}>{d.run ?? 'earlier'}</td>
                      <td style={{ ...td, textAlign: 'right' }}>{(d.rows ?? 0).toLocaleString()}</td>
                      <td style={{ ...td, color: MUT, whiteSpace: 'nowrap' }}>{when(d.mtime)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : left === 'benchmarks' ? (
              <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {bench && !bench.length && <div style={{ color: MUT, fontSize: 13, padding: 8 }}>No benchmarks</div>}
                {bench?.map((b) => <BenchCard key={b.id} b={b} onDelete={() => { if (confirm('Delete this benchmark?')) lakeApi(`/benchmarks/${b.id}`, { method: 'DELETE' }).then(loadBench).catch(() => {}) }} />)}
              </div>
            ) : (
            <div style={{ padding: 12, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
              {models?.models.map((m) => (
                <div key={m.id} style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: '11px 13px', borderLeft: `3px solid ${m.source === 'trained' ? palette.teal : palette.rose}`,
                                         opacity: m.exists ? 1 : 0.6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontWeight: 800, fontSize: 13.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={m.path}>{m.name}</span>
                    <span style={{ marginLeft: 'auto', fontSize: 10.5, fontWeight: 800, color: m.source === 'trained' ? palette.teal : palette.rose }}>{m.source}</span>
                  </div>
                  <div style={{ fontSize: 12, color: MUT, marginTop: 4 }}>
                    {m.stack ? <span style={{ fontFamily: font.label }}>{m.stack}</span> : 'no stack'}{m.feature ? ` · ${m.feature}` : ''}
                  </div>
                  <div style={{ fontSize: 12, color: MUT, marginTop: 2 }}>
                    {m.exists ? `${size(m.bytes)} · ${m.mtime ? when(m.mtime) : ''}` : 'not trained'}
                    {m.in_use_by && <span style={{ color: '#0F8A5F', fontWeight: 700 }}> · loaded by {m.in_use_by}</span>}
                  </div>
                  {m.notes && <div style={{ fontSize: 12, color: INK, marginTop: 4 }}>{m.notes}</div>}
                  {m.source === 'uploaded' && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      <select value={useFor[m.id] ?? m.stack ?? ''} onChange={(e) => setUseFor({ ...useFor, [m.id]: e.target.value })} style={{ ...filt, flex: 1, minWidth: 0 }}>
                        <option value="">stack…</option>{models.stacks.map((s) => <option key={s}>{s}</option>)}
                      </select>
                      <button onClick={() => use(m)} disabled={!(useFor[m.id] ?? m.stack)} style={btn()}>Use</button>
                      <button onClick={() => integrate(m)} style={btn()}>Integrate…</button>
                      <button onClick={() => remove(m)} style={{ ...btn(), color: '#B3272C' }}>✕</button>
                    </div>
                  )}
                </div>
              ))}
              <button onClick={() => setUpload(true)} style={{ border: `2px dashed ${LINE}`, borderRadius: 12, background: 'transparent', cursor: 'pointer', minHeight: 92,
                                                               color: palette.greyTeal, fontWeight: 700, fontFamily: 'inherit' }}>+ Upload model</button>
            </div>
            )}
          </div>
          {left === 'datasets' && (
            <div style={{ flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: `1px solid ${LINE}`, background: '#FAFCFC' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{sel.length ? `${sel.length} selected · ${rows.toLocaleString()} rows` : 'None selected'}</span>
              {selStacks.length > 1 && <span style={{ fontSize: 12, color: '#B3272C' }}>one stack only</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                {!!sel.length && <button onClick={() => setPicked(new Set())} style={btn()}>Clear</button>}
                <button onClick={train} disabled={selStacks.length !== 1} style={{ ...btn(true), opacity: selStacks.length === 1 ? 1 : 0.5 }}>Train…</button>
              </span>
            </div>
            </div>
          )}
        </Card>

        <div ref={chatRef} style={{ minHeight: 0, height: '100%' }}>
          <Card pad={0} style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ flexShrink: 0, padding: '14px 14px', borderBottom: `1px solid ${LINE}`, fontWeight: 800, fontSize: 15 }}>ML agent</div>
            <AgentChat key={chatKey} agent="ml" draft={draft} suggestions={['Which datasets are worth training on?', 'Is the BSR model better than the seed?', 'Switch ai-ran-bsr to shadow mode']} />
          </Card>
        </div>
      </div>
      {view && <Preview f={view} onClose={() => setView(null)} />}
      {upload && <Upload stacks={models?.stacks ?? []} onClose={() => setUpload(false)} onDone={loadModels} />}
    </div>
    <StudioDock servers={servers} onAsk={ask} />
    </div>
  )
}

interface Bench { id: string; t: number; stack: string; model: string; kind: 'offline' | 'live'; data: string; metric: string; unit: string
  lower_is_better: boolean; rows: number; results: { name: string; value: number; model: boolean; note?: string }[]; notes: string }

function BenchCard({ b, onDelete }: { b: Bench; onDelete: () => void }) {
  const better = (x: number, y: number) => (b.lower_is_better ? x < y : x > y)
  const rows = [...b.results].sort((x, y) => (better(x.value, y.value) ? -1 : 1))
  const model = b.results.find((r) => r.model)!
  const base = b.results.filter((r) => !r.model).reduce((best, r) => (better(r.value, best.value) ? r : best))
  const pct = Math.abs(model.value - base.value) / Math.abs(base.value || 1) * 100
  const wins = better(model.value, base.value)
  const max = Math.max(...b.results.map((r) => Math.abs(r.value))) || 1
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 12, padding: '12px 14px', borderLeft: `3px solid ${wins ? '#0F8A5F' : '#B3272C'}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 800, fontSize: 14 }}>{b.model}</span>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: MUT }}>{b.metric}{b.unit ? ` (${b.unit})` : ''} {b.lower_is_better ? '↓' : '↑'}</span>
        <span style={{ fontSize: 12, fontWeight: 800, color: wins ? '#0F8A5F' : '#B3272C' }}>{wins ? 'BEATS BASELINE' : 'BELOW BASELINE'} {wins ? '+' : '−'}{pct.toFixed(0)}%</span>
        <span style={{ marginLeft: 'auto', fontSize: 12, color: MUT }}>{when(b.t)}</span>
        <button onClick={onDelete} title="Delete" style={{ border: 'none', background: 'none', color: MUT, cursor: 'pointer', fontSize: 13 }}>✕</button>
      </div>
      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {rows.map((r) => (
          <div key={r.name} style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 230px) minmax(0, 1fr) 64px', alignItems: 'center', gap: 10, fontSize: 12.5 }}>
            <span style={{ fontWeight: r.model ? 800 : 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
            <span style={{ height: 10, borderRadius: 5, background: '#EEF3F4', overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${(Math.abs(r.value) / max) * 100}%`, background: r.model ? palette.teal : '#B9C7CC', borderRadius: 5 }} />
            </span>
            <span style={{ fontFamily: font.mono, textAlign: 'right', fontWeight: r.model ? 800 : 500 }}>{r.value.toFixed(3)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
