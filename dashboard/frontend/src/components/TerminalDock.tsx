import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { hostsApi, target, type Host } from '../screens/ScreenServers'
import { TerminalView, type TermState } from './TerminalModal'
import { ResizeGrip, useFloating } from './Floating'

const SESSION = 'dock'

export function TerminalDock() {
  const loc = useLocation()
  const [open, setOpen] = useState(false)
  const [hosts, setHosts] = useState<Host[]>([])
  const [hostId, setHostId] = useState(() => { try { return localStorage.getItem('dock.term.host') || 'primary' } catch { return 'primary' } })
  const [state, setState] = useState<TermState>('connecting')
  const [gen, setGen] = useState(0)
  const fl = useFloating('dock.terminal', { right: 170, bottom: 24 }, { w: 780, h: 470 })
  useEffect(() => {
    if (open) hostsApi<{ primary: Host; hosts: Host[] }>('').then((r) => setHosts([r.primary, ...r.hosts.filter((h) => h.test?.ssh)])).catch(() => {})
  }, [open])
  const pick = (id: string) => { setHostId(id); try { localStorage.setItem('dock.term.host', id) } catch {  } }
  const end = async () => {
    if (!confirm('End terminal?')) return
    setOpen(false)
    await hostsApi(`/${hostId}/sessions/${SESSION}`, { method: 'DELETE' }).catch(() => {})
    setGen((g) => g + 1)
  }

  if (loc.pathname === '/login') return null
  const { w: W, h: H } = fl.size
  if (!open) return (
    <button onPointerDown={(e) => fl.start(e, 140, 52)} onClick={() => !fl.dragged() && setOpen(true)}
      style={{ position: 'fixed', ...fl.fit(fl.at, 140, 52), zIndex: 900, height: 52, padding: '0 20px', borderRadius: 26, cursor: 'pointer', touchAction: 'none',
               background: '#13304A', color: '#fff', border: 'none', fontFamily: 'inherit', fontWeight: 800, fontSize: 14,
               boxShadow: '0 14px 30px -12px rgba(19,48,74,.7)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontFamily: 'monospace', fontSize: 15 }}>&gt;_</span> Terminal
    </button>
  )
  const btn: React.CSSProperties = { background: 'transparent', border: '1px solid #2B5070', color: '#DCE6EF', borderRadius: 8, padding: '3px 9px',
                                     cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 12 }
  return (
    <div style={{ position: 'fixed', ...fl.fit(fl.at, W, H), zIndex: 901, width: W, height: H, background: '#0F2233', borderRadius: 14,
                  boxShadow: '0 30px 70px -28px rgba(0,0,0,.7)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <ResizeGrip onPointerDown={fl.startResize} dark />
      <div onPointerDown={(e) => fl.start(e, W, H)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', background: '#13304A', color: '#DCE6EF', cursor: 'move', touchAction: 'none' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: state === 'open' ? '#4CD787' : state === 'connecting' ? '#E0A93B' : '#8FA9BE' }} />
        <span style={{ fontWeight: 800, fontSize: 13 }}>Terminal</span>
        <select value={hostId} onChange={(e) => pick(e.target.value)} onPointerDown={(e) => e.stopPropagation()}
          style={{ background: '#0F2233', color: '#DCE6EF', border: '1px solid #2B5070', borderRadius: 7, padding: '3px 6px', fontSize: 12, fontFamily: 'inherit' }}>
          {!hosts.some((h) => h.id === hostId) && <option value={hostId}>{hostId === 'primary' ? 'this server' : hostId}</option>}
          {hosts.map((h) => <option key={h.id} value={h.id}>{h.nickname} · {h.primary ? 'this server' : target(h)}</option>)}
        </select>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button onClick={end} style={{ ...btn, color: '#F2A3A6', borderColor: '#5A3340' }}>End</button>
          <button onClick={() => setOpen(false)} title="Hide" style={btn}>✕</button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalView key={`${hostId}-${gen}`} hostId={hostId} session={SESSION} onState={setState} />
      </div>
    </div>
  )
}
