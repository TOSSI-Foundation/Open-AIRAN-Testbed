import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getToken } from '../lib/auth'
import { font } from '../styles/theme'

export type TermState = 'connecting' | 'open' | 'closed'

export function TerminalView({ hostId, session, active = true, onState }: {
  hostId: string; session?: string; active?: boolean; onState?: (s: TermState) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const fitRef = useRef<() => void>(() => {})
  useEffect(() => {
    const term = new Terminal({ cursorBlink: true, fontFamily: font.mono, fontSize: 13, scrollback: 5000,
                                theme: { background: '#0F2233', foreground: '#DCE6EF', cursor: '#4CD787' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box.current!)
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const q = new URLSearchParams({ token: getToken() || '', ...(session ? { session } : {}) })
    const ws = new WebSocket(`${proto}://${location.host}/api/hosts/${hostId}/terminal?${q}`)
    const resize = () => {
      if (!box.current?.offsetParent) return
      fit.fit()
      if (ws.readyState === 1) ws.send(JSON.stringify({ resize: [term.cols, term.rows] }))
    }
    fitRef.current = resize
    onState?.('connecting')
    ws.onopen = () => { onState?.('open'); resize(); term.focus() }
    ws.onmessage = (e) => term.write(e.data)
    ws.onclose = () => { onState?.('closed'); term.write('\r\n\x1b[90m[disconnected]\x1b[0m\r\n') }
    const sub = term.onData((d) => ws.readyState === 1 && ws.send(d))
    const ro = new ResizeObserver(() => resize())
    ro.observe(box.current!)
    return () => { ro.disconnect(); sub.dispose(); ws.close(); term.dispose() }
  }, [hostId, session]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (active) setTimeout(() => fitRef.current(), 0) }, [active])
  return <div ref={box} style={{ width: '100%', height: '100%', padding: 6, boxSizing: 'border-box', background: '#0F2233' }} />
}

export function TerminalModal({ hostId, title, onClose }: { hostId: string; title: string; onClose: () => void }) {
  const [state, setState] = useState<TermState>('connecting')
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(14,24,32,.55)', zIndex: 1100, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 'min(1200px, 95vw)', height: '82vh', background: '#0F2233', borderRadius: 14, overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    boxShadow: '0 30px 80px -30px rgba(0,0,0,.7)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', background: '#13304A', color: '#DCE6EF' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: state === 'open' ? '#4CD787' : state === 'connecting' ? '#E0A93B' : '#8FA9BE' }} />
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>{title}</span>
          <button onClick={onClose} style={{ marginLeft: 'auto', background: 'transparent', border: '1px solid #2B5070', color: '#DCE6EF', borderRadius: 8,
                                             padding: '4px 10px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700 }}>Close</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><TerminalView hostId={hostId} onState={setState} /></div>
      </div>
    </div>,
    document.body,
  )
}
