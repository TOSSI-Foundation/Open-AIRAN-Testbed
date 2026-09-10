import { useCallback, useEffect, useRef, useState } from 'react'
import { authHeader } from '../lib/auth'
import { font, palette } from '../styles/theme'
import { TerminalView, type TermState } from './TerminalModal'
import { target, type Host } from '../screens/ScreenServers'

const maxHeight = () => Math.max(160, window.innerHeight - 36 - 320)

interface TermTab { id: string; hostId: string; title: string }
interface DockState { open: boolean; height: number; tabs: TermTab[]; active: string }
const KEY = 'studio.dock'
const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', DARK = '#0F2233'

function loadState(): DockState {
  try { const s = JSON.parse(localStorage.getItem(KEY) || ''); if (s && Array.isArray(s.tabs)) return s } catch {  }
  return { open: true, height: 300, tabs: [], active: 'job' }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...authHeader() } })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`)
  return r.json()
}

const tabBtn = (on: boolean): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 7, padding: '0 12px', height: 34, border: 'none', cursor: 'pointer',
  fontFamily: 'inherit', fontSize: 12.5, fontWeight: 700, whiteSpace: 'nowrap',
  color: on ? INK : MUT, background: on ? '#fff' : 'transparent',
  borderTop: `2px solid ${on ? palette.teal : 'transparent'}`, borderRight: `1px solid ${LINE}`,
})

interface Job { id: string; stack: string; action: string; state: string; cmd: string; started: number }
const LINE_COLOR: [RegExp, string][] = [[/^\s*ok\s/, '#4CD787'], [/^\s*no\s|^XX\s|\bERROR\b|\bfailed\b/, '#FF9AA2'], [/^!!\s/, '#FFD58A'], [/^==\s/, '#9CC8EE']]

function JobPane({ active }: { active: boolean }) {
  const [job, setJob] = useState<Job | null>(null)
  const [text, setText] = useState('')
  const off = useRef(0)
  const pre = useRef<HTMLPreElement>(null)
  useEffect(() => {
    let live = true
    const tick = async () => {
      try {
        const [latest] = await api<Job[]>('/api/deploy/jobs?limit=1')
        if (!live || !latest) return
        if (latest.id !== job?.id) { off.current = 0; setText(''); setJob(latest) }
        const r = await api<Job & { log: string; offset: number }>(`/api/deploy/jobs/${latest.id}?offset=${off.current}`)
        if (!live) return
        if (r.log) setText((t) => (latest.id === job?.id ? t : '') + r.log)
        off.current = r.offset
        setJob(r)
      } catch {  }
    }
    tick()
    const t = setInterval(tick, job?.state === 'running' ? 1000 : 4000)
    return () => { live = false; clearInterval(t) }
  }, [job?.id, job?.state])
  useEffect(() => { const el = pre.current; if (el && active) el.scrollTop = el.scrollHeight }, [text, active])
  const cancel = async () => { if (job) await api(`/api/deploy/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}) }
  if (!job) return <div style={{ padding: 16, color: MUT, fontSize: 13 }}>No jobs</div>
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderBottom: `1px solid ${LINE}`, fontSize: 12.5 }}>
        <span style={{ fontWeight: 800, color: job.state === 'running' ? palette.teal : job.state === 'ok' ? '#0F8A5F' : '#B3272C' }}>{job.state}</span>
        <span style={{ fontFamily: font.label, color: MUT }}>{job.cmd}</span>
        {job.state === 'running' && <button onClick={cancel} style={{ marginLeft: 'auto', ...smallBtn, color: '#B3272C' }}>Cancel</button>}
      </div>
      <pre ref={pre} style={{ flex: 1, margin: 0, overflow: 'auto', padding: '8px 12px', background: DARK, color: '#DCE6EF', fontFamily: font.mono, fontSize: 12, lineHeight: 1.5 }}>
        {text.replace(/\x1b\[[0-9;]*m/g, '').split('\n').map((l, i) => (
          <div key={i} style={{ color: LINE_COLOR.find(([re]) => re.test(l))?.[1] }}>{l || ' '}</div>
        ))}
      </pre>
    </div>
  )
}

interface Entry { name: string; path: string; dir: boolean; bytes: number }
const smallBtn: React.CSSProperties = { padding: '4px 10px', borderRadius: 7, border: `1px solid ${LINE}`, background: '#fff', cursor: 'pointer',
                                        fontFamily: 'inherit', fontSize: 12, fontWeight: 700, color: INK, whiteSpace: 'nowrap' }

function FilesPane({ onAsk }: { onAsk?: (text: string) => void }) {
  const [roots, setRoots] = useState<{ label: string; path: string }[]>([])
  const [dir, setDir] = useState(() => localStorage.getItem('studio.files.dir') || '')
  const [entries, setEntries] = useState<Entry[]>([])
  const [file, setFile] = useState<{ path: string; content: string; mtime: number; writable: boolean } | null>(null)
  const [text, setText] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { api<{ roots: { label: string; path: string }[] }>('/api/studio/roots').then((r) => { setRoots(r.roots); if (!dir && r.roots[0]) setDir(r.roots[0].path) }).catch(() => {}) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!dir) return
    try { localStorage.setItem('studio.files.dir', dir) } catch {  }
    api<{ entries: Entry[] }>(`/api/studio/ls?path=${encodeURIComponent(dir)}`).then((r) => setEntries(r.entries)).catch((e) => setMsg({ ok: false, text: e.message }))
  }, [dir])
  const root = roots.find((r) => dir === r.path || dir.startsWith(r.path + '/'))
  const open = async (p: string) => {
    setMsg(null)
    try { const r = await api<typeof file>(`/api/studio/file?path=${encodeURIComponent(p)}`); setFile(r); setText(r!.content) }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
  }
  const dirty = !!file && text !== file.content
  const save = useCallback(async () => {
    if (!file || !dirty) return
    try {
      const r = await api<{ mtime: number; backup: string | null }>('/api/studio/file', { method: 'PUT', body: JSON.stringify({ path: file.path, content: text, mtime: file.mtime }) })
      setFile({ ...file, content: text, mtime: r.mtime }); setMsg({ ok: true, text: r.backup ? `saved · backup ${r.backup.split('/').pop()}` : 'saved' })
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }) }
  }, [file, text, dirty])
  const crumbs = root ? dir.slice(root.path.length).split('/').filter(Boolean) : []
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr)', height: '100%' }}>
      <div style={{ borderRight: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <div style={{ padding: 8, borderBottom: `1px solid ${LINE}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <select value={root?.path ?? ''} onChange={(e) => setDir(e.target.value)}
            style={{ padding: '5px 8px', borderRadius: 7, border: `1px solid ${LINE}`, fontSize: 12.5, fontFamily: 'inherit', background: '#fff' }}>
            {roots.map((r) => <option key={r.path} value={r.path}>{r.label}</option>)}
          </select>
          <div style={{ fontSize: 11.5, fontFamily: font.mono, color: MUT, display: 'flex', flexWrap: 'wrap', gap: 3 }}>
            <a onClick={() => root && setDir(root.path)} style={{ cursor: 'pointer', color: palette.teal }}>/</a>
            {crumbs.map((c, i) => (
              <span key={i}><a onClick={() => setDir(root!.path + '/' + crumbs.slice(0, i + 1).join('/'))} style={{ cursor: 'pointer', color: palette.teal }}>{c}</a>/</span>
            ))}
          </div>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }}>
          {root && dir !== root.path && (
            <div onClick={() => setDir(dir.split('/').slice(0, -1).join('/'))} style={rowStyle(false)}>↰ ..</div>
          )}
          {entries.map((e) => (
            <div key={e.path} onClick={() => (e.dir ? setDir(e.path) : open(e.path))} style={rowStyle(file?.path === e.path)} title={e.path}>
              <span style={{ color: e.dir ? palette.navy : MUT, width: 14, display: 'inline-block' }}>{e.dir ? '▸' : '·'}</span>
              <span style={{ fontWeight: e.dir ? 700 : 500 }}>{e.name}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        {file ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', borderBottom: `1px solid ${LINE}` }}>
              <span style={{ fontFamily: font.label, fontSize: 12, fontWeight: 700, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={file.path}>
                {file.path.split('/').pop()}{dirty && <span style={{ color: '#B07908' }}> ●</span>}
              </span>
              {!file.writable && <span style={{ fontSize: 11.5, color: '#B07908', fontWeight: 700 }}>read-only</span>}
              {msg && <span style={{ fontSize: 11.5, color: msg.ok ? '#0F8A5F' : '#B3272C', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{msg.text}</span>}
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                {onAsk && <button style={smallBtn} onClick={() => onAsk(`Look at ${file.path}${dirty ? ' (I am editing it)' : ''} and tell me what it does and what I should change for this testbed.`)}>Ask ML agent</button>}
                <button style={smallBtn} onClick={() => open(file.path)}>Reload</button>
                <button style={{ ...smallBtn, color: '#fff', background: palette.teal, borderColor: palette.teal, opacity: dirty ? 1 : 0.5 }} disabled={!dirty} onClick={save}>Save</button>
              </span>
            </div>
            <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} readOnly={!file.writable}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save() }
                if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget, a = t.selectionStart; setText(text.slice(0, a) + '  ' + text.slice(t.selectionEnd)); setTimeout(() => t.setSelectionRange(a + 2, a + 2)) }
              }}
              style={{ flex: 1, resize: 'none', border: 'none', outline: 'none', padding: '8px 12px', fontFamily: font.mono, fontSize: 12.5, lineHeight: 1.55,
                       background: '#FBFDFD', color: INK, tabSize: 2, whiteSpace: 'pre', overflow: 'auto' }} />
          </>
        ) : (
          <div style={{ margin: 'auto', color: MUT, fontSize: 13 }}>{msg?.text || 'No file open'}</div>
        )}
      </div>
    </div>
  )
}
const rowStyle = (on: boolean): React.CSSProperties => ({ padding: '4px 10px', fontSize: 12.5, fontFamily: font.label, cursor: 'pointer', whiteSpace: 'nowrap',
  overflow: 'hidden', textOverflow: 'ellipsis', background: on ? 'rgba(50,121,133,.12)' : undefined, color: INK })

export function StudioDock({ servers, onAsk }: { servers: Host[]; onAsk?: (text: string) => void }) {
  const [st, setSt] = useState<DockState>(() => { const s = loadState(); return { ...s, height: Math.min(s.height, maxHeight()) } })
  const [menu, setMenu] = useState(false)
  const [conn, setConn] = useState<Record<string, TermState>>({})
  useEffect(() => { try { localStorage.setItem(KEY, JSON.stringify(st)) } catch {  } }, [st])
  const up = (patch: Partial<DockState>) => setSt((s) => ({ ...s, ...patch }))

  const addTerm = (h: Host) => {
    const id = Math.random().toString(36).slice(2, 10)
    const n = st.tabs.filter((t) => t.hostId === h.id).length + 1
    setSt((s) => ({ ...s, open: true, tabs: [...s.tabs, { id, hostId: h.id, title: `${h.nickname}${n > 1 ? ` ${n}` : ''}` }], active: id }))
    setMenu(false)
  }
  const closeTerm = async (t: TermTab) => {
    if (!confirm(`End terminal "${t.title}"?`)) return
    setSt((s) => ({ ...s, tabs: s.tabs.filter((x) => x.id !== t.id), active: s.active === t.id ? 'job' : s.active }))
    await api(`/api/hosts/${t.hostId}/sessions/${t.id}`, { method: 'DELETE' }).catch(() => {})
  }
  const drag = (e: React.MouseEvent) => {
    const y0 = e.clientY, h0 = st.height
    const move = (ev: MouseEvent) => up({ height: Math.max(160, Math.min(maxHeight(), h0 + (y0 - ev.clientY))) })
    const stop = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', stop) }
    window.addEventListener('mousemove', move); window.addEventListener('mouseup', stop)
  }
  const dot = (s?: TermState) => <span style={{ width: 7, height: 7, borderRadius: '50%', background: s === 'open' ? '#0F8A5F' : s === 'connecting' ? '#E0A93B' : '#9AAAB1' }} />

  return (
    <div style={{ position: 'relative', flex: '0 0 auto', zIndex: 30, background: '#fff', borderTop: `1px solid ${LINE}`,
                  boxShadow: '0 -10px 30px -18px rgba(39,85,120,.35)', display: 'flex', flexDirection: 'column' }}>
      {st.open && <div onMouseDown={drag} style={{ height: 5, cursor: 'ns-resize', marginTop: -3 }} />}
      <div style={{ display: 'flex', alignItems: 'stretch', background: '#F3F7F8', borderBottom: st.open ? `1px solid ${LINE}` : 'none', position: 'relative' }}>
        <button style={tabBtn(st.open && st.active === 'job')} onClick={() => up({ open: true, active: 'job' })}>Job</button>
        <button style={tabBtn(st.open && st.active === 'files')} onClick={() => up({ open: true, active: 'files' })}>Files</button>
        {st.tabs.map((t) => (
          <span key={t.id} style={{ ...tabBtn(st.open && st.active === t.id), paddingRight: 6 }} onClick={() => up({ open: true, active: t.id })}>
            {dot(conn[t.id])}<span style={{ fontFamily: font.mono }}>{'>_'} {t.title}</span>
            <span onClick={(e) => { e.stopPropagation(); closeTerm(t) }} title="Close"
              style={{ marginLeft: 4, padding: '0 5px', borderRadius: 5, color: MUT, fontWeight: 800 }}>×</span>
          </span>
        ))}
        <button style={{ ...tabBtn(false), color: palette.teal }} onClick={() => setMenu(!menu)}>+ Terminal ▾</button>
        {menu && (
          <div style={{ position: 'absolute', bottom: 38, left: 160, background: '#fff', border: `1px solid ${LINE}`, borderRadius: 10, padding: 6, zIndex: 40,
                        boxShadow: '0 14px 30px -14px rgba(39,85,120,.5)', minWidth: 230 }}>
            {servers.map((h) => (
              <button key={h.id} onClick={() => addTerm(h)}
                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 8, border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit' }}>
                <div style={{ fontWeight: 700, fontSize: 13 }}>{h.nickname}{h.primary ? ' · primary' : ''}</div>
                <div style={{ fontFamily: font.label, fontSize: 11.5, color: MUT }}>{target(h)}</div>
              </button>
            ))}
          </div>
        )}
        <button onClick={() => up({ open: !st.open })} title={st.open ? 'Collapse' : 'Expand'}
          style={{ marginLeft: 'auto', border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 14px', color: MUT, fontWeight: 800 }}>{st.open ? '▾' : '▴'}</button>
      </div>
      <div style={{ height: st.open ? st.height : 0, overflow: 'hidden', position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, display: st.active === 'job' ? 'block' : 'none' }}><JobPane active={st.open && st.active === 'job'} /></div>
        <div style={{ position: 'absolute', inset: 0, display: st.active === 'files' ? 'block' : 'none' }}><FilesPane onAsk={onAsk} /></div>
        {st.tabs.map((t) => (
          <div key={t.id} style={{ position: 'absolute', inset: 0, display: st.active === t.id ? 'block' : 'none', background: DARK }}>
            <TerminalView hostId={t.hostId} session={t.id} active={st.open && st.active === t.id}
              onState={(s) => setConn((c) => ({ ...c, [t.id]: s }))} />
          </div>
        ))}
      </div>
    </div>
  )
}
