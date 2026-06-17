import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { palette } from '../styles/theme'

interface Job { id: string; stack: string; action: string; state: string; started: number; user: string }
const api = <T,>(p: string, init?: RequestInit): Promise<T> =>
  fetch(`/api/deploy${p}`, { ...init, headers: { 'Content-Type': 'application/json', ...authHeader() } }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
const VERB: Record<string, string> = { build: 'Building', deploy: 'Deploying', all: 'Running all for', stop: 'Stopping', fetch: 'Fetching',
                                       check: 'Checking', train: 'Training', killall: 'Stopping' }
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

export function JobBar() {
  const nav = useNavigate()
  const loc = useLocation()
  const [job, setJob] = useState<Job | null>(null)
  const [pct, setPct] = useState<number | null>(null)
  const [step, setStep] = useState('')
  const [, tick] = useState(0)
  const off = useRef({ id: '', at: 0 })

  useEffect(() => {
    if (loc.pathname === '/login') return
    let live = true
    const pull = async () => {
      try {
        const js = await api<Job[]>('/jobs?limit=5')
        const j = js.find((x) => x.state === 'running' || x.state === 'orphaned') ?? null
        if (!live) return
        setJob(j)
        if (!j) { off.current = { id: '', at: 0 }; setPct(null); setStep(''); return }
        if (off.current.id !== j.id) { off.current = { id: j.id, at: 0 }; setPct(null); setStep('') }
        const r = await api<{ log: string; offset: number }>(`/jobs/${j.id}?offset=${off.current.at}`)
        if (!live) return
        off.current.at = r.offset
        const ps = [...r.log.matchAll(/\[\s*(\d{1,3})%\]/g)]
        if (ps.length) setPct(Math.min(100, Number(ps[ps.length - 1][1])))
        const steps = r.log.split('\n').filter((l) => /^== /.test(l))
        if (steps.length) { setStep(steps[steps.length - 1].slice(3, 90)); if (!ps.length) setPct(null) }
      } catch {  }
    }
    pull()
    const iv = window.setInterval(pull, 3000)
    const clk = window.setInterval(() => tick((n) => n + 1), 1000)
    return () => { live = false; window.clearInterval(iv); window.clearInterval(clk) }
  }, [loc.pathname])

  if (!job || loc.pathname === '/login') return null
  const cancel = async () => {
    if (!confirm(`Cancel ${job.action} ${job.stack}?`)) return
    await api(`/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {})
  }
  const orphan = job.state === 'orphaned'
  const color = orphan ? '#B3272C' : palette.teal
  return (
    <div style={{ position: 'relative', zIndex: 5, display: 'flex', alignItems: 'center', gap: 12, padding: '7px 18px', fontSize: 13,
                  background: '#fff', borderBottom: '1px solid #E2E9EA', color: '#0E1820' }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, animation: 'sk-pulse 1.2s infinite', flex: '0 0 8px' }} />
      <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>
        {orphan ? 'Orphaned:' : VERB[job.action] ?? job.action} {job.stack}
      </span>
      {pct != null && <span style={{ fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>}
      <span style={{ color: '#5B6E77', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{step}</span>
      <span style={{ marginLeft: 'auto', color: '#5B6E77', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {clock(Date.now() / 1000 - job.started)}
      </span>
      <button onClick={() => nav(`/deployments?stack=${job.stack}&tab=log`)} style={btn}>View log</button>
      <button onClick={cancel} style={{ ...btn, color: '#B3272C', borderColor: 'rgba(179,39,44,.35)' }}>Cancel</button>
      <span style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 3, background: 'rgba(50,121,133,.12)', overflow: 'hidden' }}>
        {pct != null
          ? <span style={{ display: 'block', height: '100%', width: `${pct}%`, background: color, transition: 'width .6s' }} />
          : <span style={{ display: 'block', height: '100%', width: '30%', background: color, animation: 'sk-jobsweep 1.6s linear infinite' }} />}
      </span>
    </div>
  )
}

const btn: React.CSSProperties = { background: '#fff', border: '1px solid #D5E0E3', borderRadius: 8, padding: '4px 10px', cursor: 'pointer',
                                   fontFamily: 'inherit', fontWeight: 700, fontSize: 12, whiteSpace: 'nowrap' }
