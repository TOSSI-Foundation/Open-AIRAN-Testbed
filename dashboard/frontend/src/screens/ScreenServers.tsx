import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { authHeader } from '../lib/auth'
import { Card, PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'
import { TerminalModal } from '../components/TerminalModal'
import { font, palette } from '../styles/theme'

export interface Specs {
  hostname?: string; arch?: string; kernel?: string; os?: string; cpu?: string; cores?: number; isolated?: string
  mem_gb?: number; hugepages_gb?: number; disk_free_gb?: number; gpus?: string[]; gpu_use?: string[]; gpu_driver?: string; torch?: string; cuda?: string; dpdk?: string
  vfio_nics?: string[]; nics?: string[]; ptp?: string; acc?: number; docker?: string; stacks?: string[]
}
export interface Host {
  id: string; nickname: string; address: string; user: string; port?: number; primary?: boolean
  specs?: Specs; test?: { ping_ms: number | null; ssh: boolean; sudo: boolean; at: number; error?: string }
}

export const target = (h: { user: string; address: string; port?: number }) => `${h.user}@${h.address}${h.port && h.port !== 22 ? `:${h.port}` : ''}`

function copyText(t: string): boolean {
  if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(t); return true }
  const ta = document.createElement('textarea')
  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'
  document.body.appendChild(ta); ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { ok = false }
  ta.remove()
  return ok
}

const INK = '#0E1820', MUT = '#5B6E77', LINE = '#E2E9EA', WELL = '#F3F7F8', OK = '#0F8A5F', BAD = '#B3272C'

export async function hostsApi<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/hosts${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...authHeader() } })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `${r.status}`)
  return r.json()
}

const btn = (primary = false, danger = false): React.CSSProperties => ({
  padding: '7px 13px', borderRadius: 9, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
  display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
  color: primary ? '#fff' : danger ? BAD : INK, background: primary ? palette.teal : '#fff',
  border: `1px solid ${primary ? palette.teal : danger ? 'rgba(179,39,44,.35)' : LINE}`,
})
const ago = (t: number) => { const s = Date.now() / 1000 - t; return s < 60 ? 'just now' : s < 3600 ? `${(s / 60) | 0}m ago` : `${(s / 3600) | 0}h ago` }

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px 1fr', gap: 8, fontSize: 12.5, padding: '3px 0' }}>
      <span style={{ color: palette.greyTeal, fontWeight: 600 }}>{k}</span>
      <span style={{ color: INK, fontFamily: mono ? font.mono : undefined, fontSize: mono ? 12 : 12.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={typeof v === 'string' ? v : undefined}>{v || '—'}</span>
    </div>
  )
}

function Badge({ on, label }: { on: boolean | undefined; label: string }) {
  return <span style={{ fontSize: 11, fontWeight: 800, padding: '2px 8px', borderRadius: 999, color: on ? OK : MUT,
                        background: on ? 'rgba(15,138,95,.10)' : WELL, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
    <span style={{ width: 7, height: 7, borderRadius: '50%', background: on ? OK : BAD }} />{label}</span>
}

function ServerCard({ h, onTest, onTerminal, onRemove, onRename, testing, trains }: {
  h: Host; onTest: () => void; onTerminal: () => void; onRemove?: () => void; onRename?: (n: string) => void; testing: boolean; trains?: boolean
}) {
  const s = h.specs || {}
  const t = h.test
  const up = h.primary || t?.ssh
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(h.nickname)
  return (
    <Card pad={0} style={{ overflow: 'hidden', border: `1px solid ${h.primary ? 'rgba(50,121,133,.45)' : LINE}` }}>
      <div style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: `1px solid ${LINE}`,
                    background: h.primary ? 'rgba(50,121,133,.06)' : '#fff' }}>
        <span style={{ width: 40, height: 40, borderRadius: 11, flex: '0 0 40px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                       background: s.gpus?.length ? 'rgba(216,105,147,.14)' : 'rgba(50,121,133,.12)', color: s.gpus?.length ? palette.rose : palette.teal }}>
          <Icon.layers size={21} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {editing && onRename ? (
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)}
                onBlur={() => { setEditing(false); if (name.trim() && name !== h.nickname) onRename(name.trim()) }}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                style={{ fontWeight: 800, fontSize: 15.5, border: `1px solid ${LINE}`, borderRadius: 6, padding: '1px 6px', fontFamily: 'inherit', width: 180 }} />
            ) : (
              <span onDoubleClick={() => onRename && setEditing(true)} title={onRename ? 'Double-click to rename' : undefined}
                style={{ fontWeight: 800, fontSize: 15.5, color: INK }}>{h.nickname}</span>
            )}
            {h.primary && <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.06em', color: '#fff', background: palette.teal, padding: '2px 8px', borderRadius: 999 }}>PRIMARY</span>}
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: up ? OK : t ? BAD : '#B9C7CC' }} title={up ? 'reachable' : 'unreachable'} />
          </div>
          <div style={{ fontFamily: font.label, fontSize: 12, color: MUT }}>{target(h)}</div>
        </div>
        {!h.primary && t?.ping_ms != null && <span style={{ fontSize: 12, fontWeight: 700, color: palette.teal }}>{t.ping_ms.toFixed(1)} ms</span>}
      </div>

      <div style={{ padding: '10px 16px' }}>
        <Row k="CPU" v={s.cpu ? `${s.cpu}` : ''} />
        <Row k="Cores" v={s.cores ? `${s.cores}${s.isolated ? ` · isolated ${s.isolated}` : ''}` : ''} />
        <Row k="Memory" v={s.mem_gb ? `${s.mem_gb} GB · hugepages ${s.hugepages_gb} GB` : ''} />
        <Row k="GPU" v={s.gpus?.length ? s.gpus.join(' · ') : 'none'} />
        {!!s.gpus?.length && <Row k="GPU load" v={(s.gpu_use ?? []).join(' · ')} mono />}
        {!!s.gpus?.length && <Row k="Driver" v={[s.gpu_driver, s.cuda && `CUDA ${s.cuda}`].filter(Boolean).join(' · ')} />}
        <Row k="PyTorch" v={s.torch ? `${s.torch.split(' ')[0]} · ${s.torch.endsWith('cuda') ? 'GPU' : 'CPU only'}` : 'not installed'} />
        <Row k="DPDK NICs" v={s.vfio_nics?.length ? s.vfio_nics.join(', ') : s.dpdk ? 'none bound' : ''} mono />
        <Row k="System" v={s.os ? `${s.os} · ${s.arch}` : ''} />
        <Row k="Running" v={s.stacks?.length ? s.stacks.join(', ') : 'nothing'} mono />
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          {trains && <span style={{ fontSize: 11, fontWeight: 800, color: '#fff', background: palette.rose, padding: '3px 9px', borderRadius: 999 }}>TRAINS ML</span>}
          <Badge on={!!s.dpdk} label={`DPDK${s.dpdk ? ` ${s.dpdk}` : ''}`} />
          <Badge on={s.ptp === 'yes'} label="PTP" />
          <Badge on={(s.acc ?? 0) > 0} label="Accelerator" />
          <Badge on={s.docker === 'yes'} label="Docker" />
          {!h.primary && <Badge on={t?.sudo} label="sudo" />}
        </div>
        {t?.error && !t.ssh && <div style={{ fontSize: 12, color: BAD, marginTop: 8 }}>{t.error}</div>}
      </div>

      <div style={{ display: 'flex', gap: 8, padding: '10px 16px', borderTop: `1px solid ${LINE}`, background: '#FAFCFC', alignItems: 'center' }}>
        <button onClick={onTest} disabled={testing} style={{ ...btn(), opacity: testing ? 0.6 : 1 }}>{testing ? 'Testing…' : 'Ping & test'}</button>
        <button onClick={onTerminal} disabled={!up} style={{ ...btn(), opacity: up ? 1 : 0.5 }}>{'>_'} Terminal</button>
        {t?.at && !h.primary && <span style={{ fontSize: 11.5, color: palette.greyTeal }}>tested {ago(t.at)}</span>}
        {onRemove && <button onClick={onRemove} style={{ ...btn(false, true), marginLeft: 'auto' }}>Remove</button>}
      </div>
    </Card>
  )
}

function AddServer({ pubkey, onClose, onAdded }: { pubkey: string | null; onClose: () => void; onAdded: () => void }) {
  const [f, setF] = useState({ nickname: '', address: '', port: '22', user: '', auth: 'password', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [copied, setCopied] = useState<boolean | null>(null)
  const cmd = pubkey ? `mkdir -p ~/.ssh && echo '${pubkey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys` : '' 
  const submit = async () => {
    setBusy(true); setErr('')
    try { await hostsApi('', { method: 'POST', body: JSON.stringify(f) }); onAdded(); onClose() }
    catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }
  const inp: React.CSSProperties = { padding: '9px 11px', borderRadius: 9, border: `1px solid ${LINE}`, background: WELL, fontSize: 13.5, fontFamily: 'inherit', outline: 'none' }
  const field = (label: string, el: React.ReactNode) => <label style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 12, fontWeight: 700 }}>{label}{el}</label>
  return createPortal(
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(14,24,32,.45)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 'min(520px, 94vw)', background: '#fff', borderRadius: 16, padding: 22, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ fontWeight: 800, fontSize: 17 }}>Add server</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          {field('Nickname', <input style={inp} value={f.nickname} placeholder="dgx-spark" onChange={(e) => setF({ ...f, nickname: e.target.value })} />)}
          {field('User', <input style={{ ...inp, fontFamily: font.mono }} value={f.user} placeholder="ubuntu" onChange={(e) => setF({ ...f, user: e.target.value.trim() })} />)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 12 }}>
          {field('Address', <input style={{ ...inp, fontFamily: font.mono }} value={f.address} placeholder="192.168.1.50" onChange={(e) => setF({ ...f, address: e.target.value.trim() })} />)}
          {field('Port', <input style={{ ...inp, fontFamily: font.mono }} value={f.port} inputMode="numeric" onChange={(e) => setF({ ...f, port: e.target.value.replace(/\D/g, '').slice(0, 5) })} />)}
        </div>
        <div style={{ display: 'flex', background: WELL, borderRadius: 10, padding: 3, gap: 3 }}>
          {(['password', 'key'] as const).map((a) => (
            <button key={a} onClick={() => setF({ ...f, auth: a })}
              style={{ flex: 1, padding: '7px 0', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 700, fontSize: 13,
                       background: f.auth === a ? '#fff' : 'transparent', color: f.auth === a ? INK : MUT, boxShadow: f.auth === a ? '0 1px 3px rgba(0,0,0,.12)' : 'none' }}>
              {a === 'password' ? 'Password' : 'SSH key'}
            </button>
          ))}
        </div>
        {f.auth === 'password' ? (
          field('Password', <input style={inp} type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />)
        ) : (
          <div style={{ fontSize: 12.5, color: MUT }}>
            Run on the server:
            <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'flex-start' }}>
              <textarea readOnly value={cmd || 'no SSH key (run ssh-keygen)'} rows={4} onFocus={(e) => e.target.select()}
                style={{ flex: 1, minWidth: 0, fontSize: 11, fontFamily: font.mono, background: WELL, padding: '7px 9px', borderRadius: 8, border: `1px solid ${LINE}`, resize: 'none', wordBreak: 'break-all' }} />
              {pubkey && <button style={btn()} onClick={() => setCopied(copyText(cmd))}>{copied === null ? 'Copy' : copied ? 'Copied' : 'Select + Ctrl+C'}</button>}
            </div>
          </div>
        )}
        {err && <div style={{ fontSize: 12.5, color: BAD }}>{err}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={btn()}>Cancel</button>
          <button onClick={submit} disabled={busy || !f.nickname || !f.address || !f.user || !f.port} style={{ ...btn(true), opacity: busy || !f.nickname || !f.address || !f.user || !f.port ? 0.5 : 1 }}>
            {busy ? 'Connecting…' : 'Add server'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ScreenServers() {
  const [data, setData] = useState<{ primary: Host; hosts: Host[]; pubkey: string | null; trains_ml: string | null } | null>(null)
  const [err, setErr] = useState('')
  const [adding, setAdding] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [term, setTerm] = useState<Host | null>(null)
  const load = useCallback(() => hostsApi<{ primary: Host; hosts: Host[]; pubkey: string | null; trains_ml: string | null }>('').then(setData).catch((e) => setErr(e.message)), [])
  useEffect(() => { load() }, [load])
  const test = async (h: Host) => {
    setTesting(h.id)
    try { await hostsApi(`/${h.id}/test`, { method: 'POST' }); await load() } catch (e) { setErr((e as Error).message) } finally { setTesting(null) }
  }
  const remove = async (h: Host) => {
    if (!confirm(`Remove ${h.nickname}?`)) return
    try { await hostsApi(`/${h.id}`, { method: 'DELETE' }); load() } catch (e) { setErr((e as Error).message) }
  }
  const rename = async (h: Host, nickname: string) => { try { await hostsApi(`/${h.id}`, { method: 'PATCH', body: JSON.stringify({ nickname }) }); load() } catch (e) { setErr((e as Error).message) } }

  return (
    <div style={{ padding: '18px 34px 40px', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <PageHeader title="Servers" actions={<button onClick={() => setAdding(true)} style={{ ...btn(true), padding: '9px 16px', fontSize: 13.5 }}>+ Add server</button>} />
      {err && <Card pad={12} style={{ color: BAD, fontSize: 13.5 }}>{err}</Card>}
      {!data ? <div style={{ color: MUT }}>Loading…</div> : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))', gap: 16, alignItems: 'start' }}>
          <ServerCard h={data.primary} trains={data.trains_ml === 'primary'} testing={testing === 'primary'} onTest={() => test(data.primary).then(load)} onTerminal={() => setTerm(data.primary)} />
          {data.hosts.map((h) => (
            <ServerCard key={h.id} h={h} trains={data.trains_ml === h.id} testing={testing === h.id} onTest={() => test(h)} onTerminal={() => setTerm(h)}
              onRemove={() => remove(h)} onRename={(n) => rename(h, n)} />
          ))}
          <button onClick={() => setAdding(true)}
            style={{ minHeight: 220, borderRadius: 16, border: `2px dashed ${LINE}`, background: 'transparent', cursor: 'pointer', fontFamily: 'inherit',
                     color: palette.greyTeal, fontWeight: 700, fontSize: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <span style={{ fontSize: 28, lineHeight: 1 }}>+</span>Add server
          </button>
        </div>
      )}
      {adding && <AddServer pubkey={data?.pubkey ?? null} onClose={() => setAdding(false)} onAdded={load} />}
      {term && <TerminalModal hostId={term.id} title={`${term.nickname} · ${target(term)}`} onClose={() => setTerm(null)} />}
    </div>
  )
}
