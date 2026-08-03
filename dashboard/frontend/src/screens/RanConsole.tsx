import { useEffect, useRef, useState } from 'react'
import { authHeader } from '../lib/auth'

const MAPT = {
  panel: 'linear-gradient(135deg, rgba(34,48,63,.92) 0%, rgba(34,48,63,.86) 45%, rgba(34,48,63,.82) 100%)',
  ink: '#E9F0F6',
  mut: '#9FB2C4',
  dim: '#8195A8',
  bd: 'rgba(255,255,255,.14)',
  sunk: 'rgba(8,14,22,.5)',
  acc: '#327985',
  bad: '#FF8A8F',
  warn: '#F0A83C',
  ok: '#5FD3A6',
}

export type LogSource = 'cu' | 'du' | 'sionna' | 'ue' | 'proxy'

const TABS: { key: LogSource; label: string }[] = [
  { key: 'cu', label: 'CU' },
  { key: 'du', label: 'DU' },
  { key: 'sionna', label: 'Sionna' },
  { key: 'ue', label: 'UE' },
  { key: 'proxy', label: 'Proxy' },
]

const ANSI = /\[[0-9;]*[A-Za-z]/g

function tone(line: string): string {
  if (/\[E\]|(^|\s)(ERROR|FATAL|Traceback|Segmentation)\b|\berror:|refused|Killed|OOM/.test(line)) return MAPT.bad
  if (/\[W\]|(^|\s)WARN(ING)?\b/.test(line)) return MAPT.warn
  if (/Registration accept|PDU SESSION|RRCSetupComplete|attached|established|Connected/i.test(line)) return MAPT.ok
  return MAPT.mut
}

export function RanConsole({ source, onSource, onClose, sceneId, left, right }: {
  source: LogSource
  onSource: (s: LogSource) => void
  onClose: () => void
  sceneId?: string
  left: number
  right: number
}) {
  const [lines, setLines] = useState<string[]>([])
  const [note, setNote] = useState('')
  const [follow, setFollow] = useState(true)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    let live = true
    const pull = async () => {
      try {
        if (source === 'sionna') {
          const r = await fetch('/api/map/live/status', { headers: authHeader() })
          const d = await r.json()
          if (!live) return
          setLines((d?.log ?? []) as string[])
          setNote(d?.running ? `streaming · ${d.updates ?? 0} updates` : 'not running')
        } else {
          const r = await fetch(`/api/ran/logs?source=${source}&lines=500`,
                                { headers: authHeader() })
          const d = await r.json()
          if (!live) return
          if (d?.ok === false) { setLines([]); setNote(String(d.error)); return }
          setLines((d.lines ?? []) as string[])
          setNote(d.exists ? (d.from_file ? String(d.path).split('/').slice(-2).join('/') : 'stdout')
                           : 'no log')
        }
      } catch {
        if (live) setNote('backend unreachable')
      }
    }
    void pull()
    const iv = setInterval(pull, 1500)
    return () => { live = false; clearInterval(iv) }
  }, [source, sceneId])

  useEffect(() => {
    if (follow) boxRef.current?.scrollTo(0, boxRef.current.scrollHeight)
  }, [lines, follow])

  return (
    <div style={{ position: 'absolute', left, right, bottom: 12, height: 268,
                  borderRadius: 16, color: MAPT.ink, background: MAPT.panel,
                  backdropFilter: 'blur(16px) saturate(150%)',
                  WebkitBackdropFilter: 'blur(16px) saturate(150%)',
                  border: '1px solid ' + MAPT.bd,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,.10), 0 14px 38px rgba(6,14,24,.45)',
                  display: 'flex', flexDirection: 'column', overflow: 'hidden', zIndex: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 12px',
                    borderBottom: '1px solid ' + MAPT.bd }}>
        {TABS.map((t) => (
          <button key={t.key} onClick={() => onSource(t.key)}
            style={{ border: '1px solid ' + (source === t.key ? 'rgba(18,160,181,.5)' : 'transparent'),
                     background: source === t.key ? 'rgba(18,160,181,.18)' : 'transparent',
                     color: source === t.key ? MAPT.ink : MAPT.dim,
                     borderRadius: 8, padding: '4px 11px', fontSize: 12, fontWeight: 700,
                     cursor: 'pointer', fontFamily: 'inherit' }}>
            {t.label}
          </button>
        ))}
        <span style={{ marginLeft: 8, fontSize: 11, color: MAPT.dim, fontWeight: 600,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11,
                          color: MAPT.mut, fontWeight: 700, cursor: 'pointer' }}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)}
              style={{ accentColor: MAPT.acc, width: 13, height: 13 }} />
            Follow
          </label>
          <button onClick={onClose}
            style={{ border: '1px solid ' + MAPT.bd, background: 'transparent', color: MAPT.mut,
                     borderRadius: 8, padding: '3px 9px', fontSize: 12, fontWeight: 700,
                     cursor: 'pointer', fontFamily: 'inherit' }}>Hide</button>
        </div>
      </div>

      <div ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget
          const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atEnd !== follow) setFollow(atEnd)
        }}
        style={{ flex: 1, overflowY: 'auto', margin: 10, padding: '9px 13px', borderRadius: 10,
                 background: MAPT.sunk, border: '1px solid ' + MAPT.bd,
                 fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                 fontSize: 11.5, lineHeight: 1.65 }}>
        {lines.length === 0
          ? <div style={{ color: MAPT.dim }}>No log</div>
          : lines.map((l, i) => {
              const clean = l.replace(ANSI, '')
              return <div key={i} style={{ color: tone(clean), whiteSpace: 'pre-wrap' }}>{clean}</div>
            })}
      </div>
    </div>
  )
}
