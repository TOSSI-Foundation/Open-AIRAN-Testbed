import { useCallback, useEffect, useState } from 'react'
import { Card, PageHeader } from '../components/ui'
import { authHeader } from '../lib/auth'
import { useAuth } from '../lib/useAuth'
import { palette } from '../styles/theme'

type Role = 'admin' | 'operator' | 'viewer'
interface User { name: string; role: Role; created?: number }
interface List { me: string; role: Role; roles: Role[]; users: User[] }

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E8EEEF', BAD = '#B3272C', OK = '#0F8A5F'
const TONE: Record<Role, [string, string]> = { admin: [palette.teal, '#fff'], operator: ['#E6EFF0', palette.teal], viewer: ['#F1F5F6', MUT] }

async function api<X>(path: string, init?: RequestInit): Promise<X> {
  const r = await fetch(`/api/users${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...authHeader(), ...(init?.headers || {}) } })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`)
  return d as X
}

const input: React.CSSProperties = { padding: '8px 10px', border: `1px solid ${LINE}`, borderRadius: 9, fontFamily: 'inherit', fontSize: 13.5, minWidth: 0 }
const btn = (primary = false, danger = false): React.CSSProperties => ({
  padding: '8px 14px', borderRadius: 9, fontFamily: 'inherit', fontSize: 13, fontWeight: 700, cursor: 'pointer',
  border: `1px solid ${primary ? palette.teal : danger ? 'rgba(179,39,44,.35)' : LINE}`,
  background: primary ? palette.teal : '#fff', color: primary ? '#fff' : danger ? BAD : INK,
})

function RolePill({ role }: { role: Role }) {
  const [bg, fg] = TONE[role]
  return <span style={{ fontSize: 12, fontWeight: 800, padding: '3px 10px', borderRadius: 999, background: bg, color: fg, textTransform: 'capitalize' }}>{role}</span>
}

export function ScreenAdmin() {
  const { user } = useAuth()
  const [l, setL] = useState<List | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState('')
  const [add, setAdd] = useState({ name: '', password: '', role: 'viewer' as Role })
  const [pw, setPw] = useState({ current: '', password: '' })
  const load = useCallback(() => api<List>('').then(setL).catch((e) => setErr(e.message)), [])
  useEffect(() => { load() }, [load])
  const isAdmin = l?.role === 'admin'

  const run = async (f: () => Promise<List | unknown>, done = '') => {
    setErr(''); setMsg('')
    try { const r = await f(); if (r && (r as List).users) setL(r as List); if (done) setMsg(done) } catch (e) { setErr((e as Error).message) }
  }

  return (
    <div style={{ padding: '18px 34px 34px', color: INK, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title="Admin" />
      {err && <div style={{ color: BAD, fontWeight: 700, fontSize: 13.5 }}>{err}</div>}
      {msg && <div style={{ color: OK, fontWeight: 700, fontSize: 13.5 }}>{msg}</div>}

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <div style={{ padding: '14px 18px', fontWeight: 800, fontSize: 16 }}>People</div>
        {l?.users.map((u) => (
          <div key={u.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 18px', borderTop: `1px solid ${LINE}`, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 800, minWidth: 140 }}>{u.name}{u.name === user && <span style={{ color: MUT, fontWeight: 600 }}> (you)</span>}</span>
            {isAdmin ? (
              <select value={u.role} onChange={(e) => run(() => api(`/${u.name}`, { method: 'PATCH', body: JSON.stringify({ role: e.target.value }) }))}
                style={{ ...input, textTransform: 'capitalize' }}>
                {l.roles.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            ) : <RolePill role={u.role} />}
            <span style={{ color: MUT, fontSize: 12.5 }}>{u.created ? new Date(u.created * 1000).toLocaleDateString() : ''}</span>
            {isAdmin && (
              <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                <button style={btn()} onClick={() => {
                  const p = prompt(`New password for ${u.name}`)
                  if (p) run(() => api(`/${u.name}`, { method: 'PATCH', body: JSON.stringify({ password: p }) }), 'Password set')
                }}>Reset password</button>
                {u.name !== user && <button style={btn(false, true)} onClick={() => confirm(`Remove ${u.name}?`) && run(() => api(`/${u.name}`, { method: 'DELETE' }))}>Remove</button>}
              </span>
            )}
          </div>
        ))}
        {isAdmin && (
          <div style={{ display: 'flex', gap: 8, padding: '12px 18px', borderTop: `1px solid ${LINE}`, flexWrap: 'wrap', background: '#F7FAFA' }}>
            <input style={input} placeholder="Name" value={add.name} onChange={(e) => setAdd({ ...add, name: e.target.value })} />
            <input style={input} placeholder="Password" type="password" value={add.password} onChange={(e) => setAdd({ ...add, password: e.target.value })} />
            <select style={{ ...input, textTransform: 'capitalize' }} value={add.role} onChange={(e) => setAdd({ ...add, role: e.target.value as Role })}>
              {l?.roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button style={btn(true)} disabled={!add.name || !add.password}
              onClick={() => run(async () => { const r = await api<List>('', { method: 'POST', body: JSON.stringify(add) }); setAdd({ name: '', password: '', role: 'viewer' }); return r }, 'Added')}>
              Add
            </button>
          </div>
        )}
      </Card>

      <Card pad={0} style={{ overflow: 'hidden', maxWidth: 560 }}>
        <div style={{ padding: '14px 18px', fontWeight: 800, fontSize: 16 }}>My password</div>
        <div style={{ display: 'flex', gap: 8, padding: '0 18px 16px', flexWrap: 'wrap' }}>
          <input style={input} type="password" placeholder="Current" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <input style={input} type="password" placeholder="New" value={pw.password} onChange={(e) => setPw({ ...pw, password: e.target.value })} />
          <button style={btn(true)} disabled={!pw.current || !pw.password}
            onClick={() => run(async () => { await api('/me/password', { method: 'POST', body: JSON.stringify(pw) }); setPw({ current: '', password: '' }) }, 'Password changed')}>
            Change
          </button>
        </div>
      </Card>
    </div>
  )
}
