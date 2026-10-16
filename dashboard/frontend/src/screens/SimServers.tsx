import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authHeader } from '../lib/auth'
import { T, S, SelectField, Hint } from './panelKit'

export interface SimDeployment {
  id: string; placement: Record<string, string>; servers: { target: string; nickname: string }[]
  publisher: string; runs: number; last: number | null; user: string; current: boolean; running: boolean
}
export interface SimState {
  stack: string; deployments: SimDeployment[]; running: boolean; running_on: string[]
  job: { id: string; action: string; state: string } | null
  mirror: { active: boolean; label: string; reachable: boolean | null; age_s: number | null }
}
interface DuList { default: string; configs: { name: string; path: string; default: boolean }[] }

export const simGet = <X,>(p: string): Promise<X> =>
  fetch(`/api/sim${p}`, { headers: authHeader() }).then(async (r) => {
    const d = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(d.detail || d.error || `HTTP ${r.status}`)
    return d as X
  })
export const simPost = (p: string, body?: unknown) =>
  fetch(`/api/sim${p}`, { method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
                          body: JSON.stringify(body ?? {}) })
    .then(async (r) => { const d = await r.json().catch(() => ({})); return r.ok ? d : { ok: false, error: d.detail || d.error || `HTTP ${r.status}` } })
    .catch((e) => ({ ok: false, error: String(e) }))

export function useSimState(): SimState | null {
  const [st, setSt] = useState<SimState | null>(null)
  useEffect(() => {
    let on = true
    const pull = () => simGet<SimState>('/deployments').then((r) => on && setSt(r)).catch(() => {})
    pull()
    const iv = setInterval(pull, 3000)
    return () => { on = false; clearInterval(iv) }
  }, [])
  return st
}

const ago = (t?: number | null) => {
  if (!t) return ''
  const s = Math.max(0, Date.now() / 1000 - t)
  return s < 3600 ? `${Math.max(1, (s / 60) | 0)}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`
}

export function SimServers({ st, pick, onPick, duPath, onDu }: {
  st: SimState | null; pick: SimDeployment | null; onPick: (d: SimDeployment) => void
  duPath: string; onDu: (p: string) => void
}) {
  const nav = useNavigate()
  const [du, setDu] = useState<DuList | null>(null)
  const [err, setErr] = useState('')
  const target = pick?.publisher

  useEffect(() => {
    setDu(null); setErr('')
    if (!target) return
    simGet<DuList>(`/du-configs?target=${encodeURIComponent(target)}`)
      .then((r) => { setDu(r); if (!r.configs.some((c) => c.path === duPath)) onDu(r.configs.find((c) => c.default)?.path ?? r.configs[0]?.path ?? '') })
      .catch((e) => setErr(e.message))
  }, [target]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!st) return <Hint>Loading…</Hint>
  if (!st.deployments.length) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontWeight: 800, color: '#B3272C' }}>Not deployed</span>
        <button className="sk-btn-ghost" style={{ marginLeft: 'auto', padding: '6px 12px', fontSize: 12.5 }}
          onClick={() => nav(`/deployments?stack=${st.stack}`)}>Deploy →</button>
      </div>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: S.sm }}>
      {st.deployments.map((d) => {
        const on = pick?.id === d.id
        return (
          <button key={d.id} onClick={() => onPick(d)} disabled={st.running && !d.running}
            style={{ textAlign: 'left', padding: '9px 11px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                     border: `1px solid ${on ? T.brand : T.bd}`, background: on ? 'rgba(50,121,133,.07)' : '#fff',
                     opacity: st.running && !d.running ? 0.5 : 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: d.running ? '#0F8A5F' : '#B9C7CC' }} />
              <span style={{ fontWeight: 800, fontSize: 13.5 }}>{d.servers.map((s) => s.nickname).join(' + ')}</span>
              {d.running && <span style={{ fontSize: 11.5, fontWeight: 800, color: '#0F8A5F' }}>running</span>}
              <span style={{ marginLeft: 'auto', fontSize: 11.5, color: T.mut }}>{d.runs}× · {ago(d.last)}</span>
            </div>
          </button>
        )
      })}
      {target && (
        <div style={{ marginTop: S.xs }}>
          {err ? <Hint tone="warn">{err}</Hint> : !du ? <Hint>Loading…</Hint> : (
            <SelectField label="O-DU config" value={duPath} onChange={onDu}
              options={du.configs.map((c) => c.path)} labels={du.configs.map((c) => c.name)} />
          )}
        </div>
      )}
    </div>
  )
}
