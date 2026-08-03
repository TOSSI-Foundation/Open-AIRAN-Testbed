import { useEffect, useRef, useState } from 'react'
import { simPost, type SimDeployment, type SimState } from './SimServers'
import { authHeader } from '../lib/auth'
import { Sparkline } from '../components/Sparkline'
import { color, tone, radius } from '../styles/theme'

export interface Stage { key: string; label: string; ok: boolean; detail?: string | null }
export interface UeStatus {
  present: boolean; sync?: number; sib1?: number; rar?: number; rrc?: number; reg?: number
  stage?: string; ip?: string | null; attached?: boolean
  sinr?: number | null; sinr_samples?: { sinr: number; cqi: number | null }[]
  sinr_last_seen?: number | null; sinr_stale?: boolean
}
interface RanStatus {
  ok: boolean; stages: Stage[]
  cu: { running: boolean; ngap: boolean; exit_code: number | null; log: string[] }
  du: { running: boolean; f1: boolean; channel: boolean; exit_code: number | null; log: string[] }
  ue: UeStatus
}

async function post(path: string, body?: unknown) {
  try {
    const r = await fetch(`/api/ran${path}`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

async function postMap(path: string, body?: unknown) {
  try {
    const r = await fetch(`/api/map${path}`, {
      method: 'POST',
      headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return await r.json()
  } catch (e) {
    return { ok: false, error: String(e) }
  }
}

function ladderWithSionna(stages: Stage[], chanOk: boolean): Stage[] {
  const out: Stage[] = []
  for (const s of stages) {
    out.push(s)
    if (s.key === 'du') {
      out.push({ key: 'sionna', label: 'Sionna', ok: chanOk, detail: chanOk ? 'streaming' : null })
    }
  }
  return out
}

export function RanPanel({ duConfig, sceneId, flat, onStarted, onStopped, onCleanup, hideLadder, onState, platform }: {
  duConfig?: string; sceneId?: string; flat?: boolean
  platform?: { deployment: SimDeployment | null; state: SimState | null }
  onStarted?: (source: 'cu' | 'du' | 'sionna' | 'ue') => void
  onStopped?: () => void
  onCleanup?: () => void
  hideLadder?: boolean
  onState?: (s: { stages: Stage[]; busy: boolean; ue: UeStatus | null }) => void
}) {
  const [status, setStatus] = useState<RanStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [moveBusy, setMoveBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [ping, setPing] = useState<{ loss_pct: number | null; avg_rtt_ms: number | null } | null>(null)
  const [chan, setChan] = useState<{
    running: boolean; updates?: number; moving?: boolean
    params?: { mode?: string; move_start?: string; laps?: number }
  } | null>(null)
  const [moveStart, setMoveStart] = useState<'' | 'auto' | 'on_ip' | 'manual'>('auto')
  const [path, setPath] = useState<'' | 'one' | 'two'>('two')
  const [rounds, setRounds] = useState('')
  const twoWay = path === 'two'
  const roundsNum = rounds === '' ? 0 : Math.max(0, Math.min(1000, Number(rounds) || 0))

  const timer = useRef<number | null>(null)
  useEffect(() => {
    const tick = async () => {
      try {
        const r = await fetch('/api/ran/status', { headers: authHeader() })
        if (r.ok) setStatus(await r.json())
      } catch {
      }
      try {
        const c = await fetch('/api/map/live/status', { headers: authHeader() })
        if (c.ok) setChan(await c.json())
      } catch {
      }
    }
    tick()
    timer.current = window.setInterval(tick, 2000)
    return () => {
      if (timer.current) clearInterval(timer.current)
    }
  }, [])

  const act = async (label: string, fn: () => Promise<any>) => {
    setBusy(label)
    setNote(null)
    const r = await fn()
    setBusy(null)
    if (r && r.ok === false) setNote(r.error || `${label} failed`)
    else setNote(`${label} ok`)
  }

  const releaseWalk = async () => {
    setMoveBusy(true)
    setNote(null)
    const r = await postMap('/live/move')
    setMoveBusy(false)
    if (r && r.ok === false) setNote(r.error || 'Start UE on map failed')
    else setNote('UE walking')
  }

  const ue = status?.ue
  const stages = ladderWithSionna(status?.stages ?? DEFAULT_STAGES, !!chan?.running)
  const walkState = !chan?.running ? 'idle' : chan?.moving ? 'walking' : 'holding'
  const walkChip = walkState === 'walking' ? tone.ok
    : walkState === 'holding' ? tone.warn
    : tone.idle
  useEffect(() => {
    onState?.({ stages, busy: !!busy, ue: ue ?? null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, chan?.running, busy])
  const sinrPoints = ue?.sinr_samples?.length
    ? toPoints(ue.sinr_samples.map((s) => s.sinr))
    : ''

  const ueDetail = ue?.present ? (
        <div style={{ marginTop: 12, border: '1px solid #EDF2F3', borderRadius: 10, overflow: 'hidden' }}>
          <div style={{ display: 'flex', background: '#F7FAFA', padding: '6px 10px', fontSize: 10, fontWeight: 700, color: '#6D8E99' }}>
            <span style={{ flex: 1 }}>UE-1</span>
            {['SYNC', 'SIB1', 'RAR', 'RRC', 'REG'].map((k) => <span key={k} style={{ width: 42, textAlign: 'center' }}>{k}</span>)}
          </div>
          <div style={{ display: 'flex', padding: '8px 10px', alignItems: 'center', fontSize: 12.5 }}>
            <span style={{ flex: 1, fontWeight: 700, color: ue.attached ? '#0FA36B' : ue.stage === 'searching' ? '#8A9BA3' : '#B07908' }}>
              {ue.stage}
            </span>
            {[ue.sync, ue.sib1, ue.rar, ue.rrc, ue.reg].map((v, i) => (
              <span key={i} style={{ width: 42, display: 'flex', justifyContent: 'center' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: v ? '#0F8A5F' : '#B3272C' }} />
              </span>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 10px', borderTop: '1px solid #F1F5F6' }}>
            <span style={{ fontSize: 12.5, color: '#5B6E77', fontWeight: 600 }}>
              IP <span className="sk-mono" style={{ color: ue.ip ? '#26343B' : '#9AAAB1', fontWeight: 700 }}>{ue.ip ?? '—'}</span>
            </span>
            <button
              disabled={!ue.attached || busy === 'ping'}
              onClick={() => act('ping', async () => {
                const r = await post('/ue/1/ping')
                if (r.ok !== false) setPing({ loss_pct: r.loss_pct, avg_rtt_ms: r.avg_rtt_ms })
                return r
              })}
              style={{
                border: '1px solid #DCE7E7', background: '#fff', borderRadius: 8, padding: '5px 12px',
                fontSize: 12.5, fontWeight: 700, color: ue.attached ? '#327985' : '#9AAAB1',
                cursor: ue.attached ? 'pointer' : 'not-allowed', fontFamily: 'inherit',
              }}
            >
              Ping 8.8.8.8
            </button>
          </div>
          {ping && (
            <div style={{ padding: '6px 10px', borderTop: '1px solid #F1F5F6', fontSize: 11, color: '#5B6E77', fontWeight: 600 }}>
              {ping.loss_pct != null ? `${ping.loss_pct}% loss` : 'no reply'}
              {ping.avg_rtt_ms != null && ` · ${ping.avg_rtt_ms} ms avg`}
            </div>
          )}
        </div>
  ) : null

  return (
    <div style={flat ? { marginTop: 2 }
      : { border: '1px solid #E7EEEF', borderRadius: 12, padding: 14, marginTop: 12, background: '#fff' }}>
      {!flat && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.2px' }}>Real RAN</div>
          <span style={{ fontSize: 11, color: '#6D8E99', fontWeight: 700 }}>
            {ue?.attached ? 'attached' : status?.du.running ? 'running' : 'idle'}
          </span>
        </div>
      )}

      {!hideLadder && <Ladder stages={stages} busy={!!busy} />}

      {platform && (() => {
        const st = platform.state, dep = platform.deployment
        const job = st?.job, running = !!st?.running
        const where = dep?.servers.map((x) => x.nickname).join(' + ') || '—'
        return (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 6 }}>
            <RanBtn label={job?.action === 'deploy' && job.state === 'running' ? `Starting on ${where}…` : `Run on ${where}`}
              busy={busy} running={running}
              disabled={!dep || !sceneId || running || !!job}
              onClick={() => { onStarted?.('sionna'); act('Run', () => simPost('/run', {
                placement: dep!.placement, scene_id: sceneId, du_config: duConfig,
                move_start: moveStart, loop_route: twoWay, laps: roundsNum })) }} />
            <button disabled={!running || !!job}
              onClick={() => act('Stop', async () => { const r = await simPost('/stop'); onCleanup?.(); onStopped?.(); return r })}
              style={{ border: '1px solid rgba(179,39,44,.35)', background: '#fff', color: '#B3272C', borderRadius: 8, padding: '0 16px',
                       fontSize: 12.5, fontWeight: 800, cursor: !running || job ? 'default' : 'pointer', fontFamily: 'inherit',
                       opacity: !running || job ? 0.5 : 1 }}>
              {job?.action === 'stop' && job.state === 'running' ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        )
      })()}
      {!platform && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
        <RanBtn label="Start CU" busy={busy} running={status?.cu.running}

          onClick={() => { onStarted?.('cu'); act('CU start', () => post('/cu/start')) }} />
        <RanBtn label="Start DU" busy={busy} running={status?.du.running}
          disabled={!status?.cu.running}
          onClick={() => { onStarted?.('du'); act('DU start', () => post('/du/start', duConfig ? { du_config: duConfig } : {})) }} />
        <RanBtn label="Sionna" busy={busy} running={chan?.running}
          disabled={!status?.du.running}
          onClick={() => {
            if (ue?.attached && !chan?.running &&
                !window.confirm('UE attached; it will drop. Start channel anyway?')) return
            onStarted?.('sionna'); act('Sionna channel', () =>
            postMap('/live/start', {
              owner: 'raytrace',
              scene_id: sceneId, du_config: duConfig,
              move_start: moveStart, loop_route: twoWay, laps: roundsNum,
            })) }} />
        <RanBtn label="Start UE" busy={busy} running={status?.stages.find((s) => s.key === 'ue')?.ok}
          disabled={!status?.du.running}
          onClick={() => { onStarted?.('ue'); act('UE start', () => post('/ue/start', { scene_id: sceneId })) }} />
      </div>}
      {status?.du.running && !chan?.running && (
        <Note>
          No Sionna channel
        </Note>
      )}

      <div style={{ marginTop: 10, padding: '8px 10px', border: '1px solid #EDF2F3',
                    borderRadius: 10, background: '#FAFCFC' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      gap: 8, marginBottom: 7 }}>
          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.6px',
                         textTransform: 'uppercase', color: '#6D8E99' }}>
            UE movement
          </span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {chan?.running && (
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.3px',
                             textTransform: 'uppercase', padding: '2px 6px', borderRadius: 999,
                             color: tone.idle.fg, background: tone.idle.bg }}>locked</span>
            )}
            <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.4px',
                           textTransform: 'uppercase', padding: '2px 7px', borderRadius: 999,
                           color: walkChip.fg, background: walkChip.bg }}>{walkState}</span>
          </span>
        </div>

        <MoveField label="Starts">
          <select value={moveStart} disabled={!!chan?.running} style={selStyle}
            onChange={(e) => setMoveStart(e.target.value as '' | 'auto' | 'on_ip' | 'manual')}>
            <option value="auto">with the channel</option>
            <option value="on_ip">when the UE gets an IP</option>
            <option value="manual">when I press the button</option>
          </select>
        </MoveField>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8 }}>
          <MoveField label="Path">
            <select value={path} disabled={!!chan?.running} style={selStyle}
              onChange={(e) => setPath(e.target.value as '' | 'one' | 'two')}>
              <option value="one">one way</option>
              <option value="two">both way</option>
            </select>
          </MoveField>
          <MoveField label="Rounds (0 = ∞)">
            <input type="number" min={0} max={1000} value={rounds} placeholder="0"
              disabled={!!chan?.running}
              style={{ ...selStyle, fontVariantNumeric: 'tabular-nums' }}
              onChange={(e) => setRounds(e.target.value)} />
          </MoveField>
        </div>

        {chan?.running && chan?.params?.mode === 'route' && chan?.params?.move_start !== 'auto' && (
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              disabled={!!chan?.moving || moveBusy}
              onClick={releaseWalk}
              style={{
                padding: '6px 12px', fontSize: 12, fontWeight: 700, borderRadius: 8,
                cursor: chan?.moving ? 'default' : 'pointer',
                border: '1px solid ' + (chan?.moving ? '#DCE5E8' : '#327985'),
                background: chan?.moving ? '#F2F6F7' : '#327985',
                color: chan?.moving ? '#9AAAB1' : '#fff',
              }}>
              {chan?.moving ? 'Walking' : 'Start UE on map'}
            </button>
            <span style={{ fontSize: 11, color: '#6D8E99', fontWeight: 600 }}>
              {!chan?.moving && chan?.params?.move_start === 'on_ip' ? 'waits for IP' : ''}
            </span>
          </div>
        )}
      </div>

      {ue?.present && (
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#6D8E99', fontWeight: 700 }}>
            UE detail — {ue.stage}{ue.ip ? ` · ${ue.ip}` : ''}
          </summary>
          {ueDetail}
        </details>
      )}

      {ue?.present && ue.sinr_stale && (
        <details style={{ marginTop: 10 }}>
          <summary style={{ cursor: 'pointer', fontSize: 11, color: '#B07908', fontWeight: 700 }}>
            UE not measuring — tunnel lost
          </summary>
          <div style={{ fontSize: 11, color: '#6D8E99', fontWeight: 500, marginTop: 4, lineHeight: 1.5 }}>
            Last SINR {ue.sinr_last_seen} dB · restart DU, then UE
          </div>
        </details>
      )}
      {ue?.present && !sinrPoints && (
        <div style={{ marginTop: 10, fontSize: 11, color: '#9AAAB1', fontWeight: 600 }}>
          No SINR
        </div>
      )}
      {sinrPoints && (
        <div style={{ marginTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6D8E99', fontWeight: 700 }}>
            <span>MODEM SINR (dB)</span>
            <span style={{ color: '#327985' }}>{ue?.sinr != null ? `${ue.sinr} dB` : ''}</span>
          </div>
          <Sparkline points={sinrPoints} color="#327985" height={40} />
        </div>
      )}

      {!platform && <div style={{ display: 'flex', gap: 8, marginTop: 12, justifyContent: 'flex-end' }}>
        <button
          onClick={() => act('cleanup', async () => {
            await postMap('/live/stop', { owner: 'raytrace' })
            const r = await post('/cleanup')
            onCleanup?.()
            onStopped?.()
            return r
          })}
          disabled={busy === 'cleanup'}
          style={{
            border: '1px solid #E7EEEF', background: 'transparent', color: '#8A9BA3',
            borderRadius: 8, padding: '5px 12px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit',
          }}
        >
          {busy === 'cleanup' ? 'Cleaning…' : 'Stop all / cleanup'}
        </button>
      </div>}
      {note && <div style={{ marginTop: 8, fontSize: 11, color: note.includes('ok') ? '#327985' : '#B07908', fontWeight: 600 }}>{note}</div>}
      {status?.du.exit_code != null && status.du.exit_code !== 0 && (
        <Note>
          DU exited {status.du.exit_code}: {status.du.log.slice(-1)[0]}
        </Note>
      )}
    </div>
  )
}

const DEFAULT_STAGES: Stage[] = [
  { key: 'core', label: 'Core', ok: false },
  { key: 'cu', label: 'CU', ok: false },
  { key: 'du', label: 'DU', ok: false },
  { key: 'ue', label: 'UE', ok: false },
  { key: 'attached', label: 'Attached', ok: false },
]

const INLINE_DETAIL_MAX = 14

export function Ladder({ stages, busy }: { stages: Stage[]; busy: boolean }) {
  const nextIdx = stages.findIndex((s) => !s.ok)
  const done = nextIdx === -1
  const current = done ? stages[stages.length - 1] : stages[nextIdx]
  const okCount = stages.filter((s) => s.ok).length
  const promoted = current && current.detail && current.detail.length > INLINE_DETAIL_MAX
    ? { key: current.key, label: current.label, text: current.detail }
    : null
  const isWarning = !!promoted && /(late|error|partly|cannot|dropped|idle|slow|no link)/i
    .test(promoted.text)
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 800, letterSpacing: '-.3px',
                       color: done ? '#0FA36B' : busy ? '#B07908' : '#0E1820' }}>
          {done ? 'Attached' : `Waiting on ${current?.label ?? '—'}`}
        </span>
        <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.2px',
                       padding: '1.5px 7px', borderRadius: 999,
                       color: done ? '#0FA36B' : tone.idle.fg,
                       background: done ? '#E6F6EF' : tone.idle.bg }}>
          {okCount}/{stages.length}
        </span>
      </div>
      <div style={{ display: 'flex', gap: 4 }}>
        {stages.map((s, i) => {
          const active = !done && i === nextIdx
          const short = s.detail && s.detail.length <= INLINE_DETAIL_MAX ? s.detail : null
          return (
            <div key={s.key} style={{ flex: 1, minWidth: 0, textAlign: 'center' }}>
              <div style={{ height: 6, borderRadius: 3, transition: 'background .3s',
                            background: s.ok ? '#0FA36B' : active ? '#F0A83C' : '#E2E9EA',
                            animation: active && busy ? 'sk-pulse 1.4s ease-in-out infinite' : undefined }} />
              <div style={{ fontSize: 9.5, fontWeight: active ? 800 : 700, marginTop: 5,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                            color: s.ok ? '#327985' : active ? '#B07908' : '#9AAAB1' }}
                title={s.detail || s.label}>{s.label}</div>
              {short && (
                <div style={{ fontSize: 9, color: tone.ok.fg, fontWeight: 700, marginTop: 1,
                              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                  title={short}>{short}</div>
              )}
            </div>
          )
        })}
      </div>
      {promoted && (
        <div style={{ marginTop: 9, padding: '7px 10px', borderRadius: radius.sm,
                      fontSize: 11, lineHeight: 1.5, fontWeight: 600,
                      color: isWarning ? tone.warn.fg : tone.neutral.fg,
                      background: isWarning ? tone.warn.bg : tone.neutral.bg }}>
          <span style={{ fontWeight: 800 }}>{promoted.label}</span>{' — '}{promoted.text}
        </div>
      )}
    </div>
  )
}

const selStyle: React.CSSProperties = {
  width: '100%', padding: '4px 6px', fontSize: 11.5, fontWeight: 600, color: '#33484F',
  border: '1px solid #DCE5E8', borderRadius: 7, background: '#fff',
}

function Note({ children, kind = 'warn' }: { children: React.ReactNode; kind?: 'warn' | 'idle' }) {
  const t = kind === 'idle' ? tone.idle : tone.warn
  return (
    <div style={{ marginTop: 7, padding: '6px 9px', borderRadius: radius.sm,
                  fontSize: 11, fontWeight: 600, lineHeight: 1.45,
                  color: t.fg, background: t.bg }}>
      {children}
    </div>
  )
}

function MoveField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{ display: 'block', fontSize: 10, fontWeight: 700, color: '#9AAAB1',
                     marginBottom: 3 }}>{label}</span>
      {children}
    </label>
  )
}

function RanBtn({ label, onClick, busy, running, disabled }: {
  label: string; onClick: () => void; busy: string | null; running?: boolean; disabled?: boolean
}) {
  const off = disabled || !!busy
  return (
    <button
      onClick={onClick}
      disabled={off}
      style={{
        padding: '8px 0', borderRadius: 8, fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
        border: 'none', cursor: off ? 'not-allowed' : 'pointer',
        background: running ? '#E6EFF0' : off ? '#F3F7F8' : '#327985',
        color: running ? '#327985' : off ? '#9AAAB1' : '#fff',
      }}
    >
      {running ? '● ' + label.replace('Start ', '') : label}
    </button>
  )
}

function toPoints(vals: number[]): string {
  if (vals.length < 2) return ''
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1
  return vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * 240
    const y = 36 - ((v - min) / range) * 32
    return `${x.toFixed(0)},${y.toFixed(0)}`
  }).join(' ')
}
