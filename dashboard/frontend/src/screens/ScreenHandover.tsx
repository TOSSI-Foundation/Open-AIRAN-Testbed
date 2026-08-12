import { UserChip } from '../components/TopBar'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { mapApi, isError, type SceneMeta } from '../lib/mapApi'
import { authHeader } from '../lib/auth'
import { Icon } from '../components/Icon'
import { T, S, Section, Readout, Hint, Tag } from './panelKit'

const MAP_URL = `/sionna-map/index.html?v=${Date.now()}&chrome=operate`
const HO_SCENE_KEY = 'tossi.handover.lastScene'

const PANEL_W = 408
const PANEL_INSET = 12
const PANEL_TAB_W = 22
const PANEL_TAB_H = 44
const CONTEXT_KM = 1.2
const CELL_BINDS = ['tcp://127.0.0.1:5566', 'tcp://127.0.0.1:5567']

type Cell = {
  running: boolean; amf: boolean; xn: boolean
  rnti: string | null; pci: number | null; scheduling: number; last_t: string | null
}
type HoStatus = {
  ok: boolean
  ue_listening: boolean; ue_running: boolean
  gnb1: Cell; gnb2: Cell
  serving_pci: number | null; serving_gnb: number | null
}

const EMPTY_CELL: Cell = {
  running: false, amf: false, xn: false,
  rnti: null, pci: null, scheduling: 0, last_t: null,
}

export function ScreenHandover() {
  const nav = useNavigate()
  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [panelFolded, setPanelFolded] = useState(() => {
    const saved = localStorage.getItem('tossi.handover.panelFolded')
    return saved === null ? true : saved === '1'
  })

  const [mapReady, setMapReady] = useState(false)
  const [scene, setScene] = useState<SceneMeta | null>(null)
  const [status, setStatus] = useState<HoStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [step, setStep] = useState<'up' | 'cells' | 'ho' | 'watch'>('up')
  const [note, setNote] = useState<string | null>(null)

  const [hoOutcome, setHoOutcome] = useState<
    { state: string; detail?: string; reason?: string } | null>(null)
  const watching = useRef<{ since: string; to: number } | null>(null)
  const giveUpAtRef = useRef<number>(0)

  const [live, setLive] = useState<{ running?: boolean; scene_id?: string;
    params?: { mode?: string }; last?: { seq?: number; pos?: number[] } } | null>(null)
  const [walked, setWalked] = useState(0)
  const routeRef = useRef<{ positions?: number[][] } | null>(null)
  const routeForRef = useRef<string | null>(null)
  const lastPosRef = useRef<number[] | null>(null)

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin)
  }, [])

  useEffect(() => {
    localStorage.setItem('tossi.handover.panelFolded', panelFolded ? '1' : '0')
    post({ type: 'sk-inset', right: panelFolded ? PANEL_TAB_W + PANEL_INSET * 2
                                                : PANEL_W + PANEL_INSET * 2 })
  }, [panelFolded, post])

  const [scenes, setScenes] = useState<SceneMeta[]>([])
  useEffect(() => {
    let alive = true
    void (async () => {
      const list = await mapApi.scenes()
      if (!alive || isError(list)) return
      const built = (list as SceneMeta[]).filter((s) => s.state === 'built')
      setScenes(built)
      const mine = localStorage.getItem(HO_SCENE_KEY)
                   || localStorage.getItem('tossi.twin.lastScene')
      setScene(built.find((s) => s.scene_id === mine) ?? built[0] ?? null)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (scene) localStorage.setItem(HO_SCENE_KEY, scene.scene_id)
  }, [scene])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      if ((e.data || {}).type === 'sk-ready') {
        setMapReady(true)
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'sk-inset', right: PANEL_W + PANEL_INSET * 2 }, window.location.origin)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const loadedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!mapReady || !scene || loadedRef.current === scene.scene_id) return
    loadedRef.current = scene.scene_id
    let live = true
    void (async () => {
      const pkg = await mapApi.scenePackage(scene.scene_id)
      if (!live || isError(pkg)) return
      post({ type: 'sk-load-manifest', manifest: (pkg as any).manifest ?? pkg,
             padKm: CONTEXT_KM, lock: true })

      const c = await mapApi.sceneCoverage(scene.scene_id)
      if (live && !isError(c) && (c as any).overlay) {
        post({ type: 'sk-load-coverage', overlay: (c as any).overlay })
      }

      const full = await mapApi.scene(scene.scene_id)
      if (!live || isError(full)) return
      const paths = ((full as any)?.trace?.links ?? [])
        .flatMap((l: any) => l.path_detail ?? [])
        .filter((q: any) => (q.points ?? []).length > 1)
      const org = (full as any)?.origin_lonlat ?? null
      if (paths.length && org) {
        post({ type: 'sk-load-rays', paths, origin_lonlat: org })
        post({ type: 'sk-show-rays' })
      }
    })()
    return () => { live = false }
  }, [mapReady, scene, post])

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/ran/ho/status', { headers: authHeader() })
        const d = (await r.json()) as HoStatus
        if (alive) setStatus(d)
      } catch {  }
    }
    void pull()
    const iv = setInterval(pull, 2000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  useEffect(() => {
    post({ type: 'sk-serving', pci: status?.serving_pci ?? null })
  }, [status?.serving_pci, post])

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/map/live/status', { headers: authHeader() })
        const d = await r.json()
        if (!alive) return
        const owner = d?.params?.owner
        if (d?.running && owner !== 'handover') {
          setLive(null)
          if (routeForRef.current) { routeForRef.current = null; routeRef.current = null }
          post({ type: 'sk-live-ue', enu: null })
          lastPosRef.current = null
          return
        }
        setLive(d)
        if (!d?.running) {
          if (routeForRef.current) {
            routeForRef.current = null
            routeRef.current = null
            post({ type: 'sk-live-ue', enu: null })
          }
          lastPosRef.current = null
          setWalked(0)
          return
        }
        const key = `${d.scene_id}:${d.params?.mode}`
        if (routeForRef.current !== key) {
          routeForRef.current = key
          routeRef.current = null
          lastPosRef.current = null
          setWalked(0)
          const rr = await fetch('/api/map/live/route', { headers: authHeader() })
            .then((x) => x.json()).catch(() => null)
          if (alive && rr?.route?.positions) routeRef.current = rr.route
        }
        const pos: number[] | null = d.last?.pos && d.last.pos.length >= 2 ? d.last.pos : null
        if (pos) {
          const prev = lastPosRef.current
          if (prev) {
            const step = Math.hypot(pos[0] - prev[0], pos[1] - prev[1])
            if (step > 0.01) setWalked((w) => w + step)
          }
          lastPosRef.current = pos
          post({ type: 'sk-live-ue', enu: pos,
                 gain_db: d.last?.gain_db, applied_db: d.last?.applied_db,
                 paths: d.last?.paths })
        }
      } catch {  }
    }
    void pull()
    const iv = setInterval(pull, 1000)
    return () => { alive = false; clearInterval(iv) }
  }, [post])

  const startSionna = useCallback(async () => {
    if (!scene) return
    setBusy('sionna'); setNote(null)
    try {
      const r = await fetch('/api/map/live/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ owner: 'handover', scene_id: scene.scene_id,
                               move_start: 'auto', binds: CELL_BINDS }),
      })
      const d = await r.json()
      const n = (d?.params?.binds ?? []).length
      setNote(d?.ok
        ? (n > 1 ? `channel streaming — one per cell (${n})` : 'channel streaming')
        : (d?.error || 'could not start the channel'))
    } catch {
      setNote('could not reach the backend')
    } finally {
      setBusy(null)
    }
  }, [scene])

  const act = useCallback(async (key: string, path: string) => {
    setBusy(key); setNote(null)
    try {
      const r = await fetch(path, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() }, body: '{}' })
      if (r.status === 401) { setNote('session expired'); return }
      const d = await r.json()
      setNote(d?.ok ? (d.verdict || d.note || 'ok') : (d?.error || 'failed'))
    } catch {
      setNote('could not reach the backend')
    } finally {
      setBusy(null)
    }
  }, [])

  const stopEverything = useCallback(async () => {
    setBusy('stop'); setNote(null)
    try {
      await fetch('/api/map/live/stop', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ owner: 'handover' }) }).catch(() => null)
      const r = await fetch('/api/ran/ho/stop', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() }, body: '{}' })
      const d = await r.json()
      setNote(d?.ok ? 'everything stopped' : (d?.error || 'could not stop everything'))
      post({ type: 'sk-live-ue', enu: null })
      post({ type: 'sk-serving', pci: null })
      setWalked(0)
    } catch {
      setNote('could not reach the backend')
    } finally {
      setBusy(null)
    }
  }, [post])

  const doHandover = useCallback(async () => {
    setBusy('trigger'); setNote(null); setHoOutcome(null)
    try {
      const r = await fetch('/api/ran/ho/trigger', { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() }, body: '{}' })
      const d = await r.json()
      if (!d?.ok) { setNote(d?.error || 'could not trigger handover'); return }
      setNote(d.verdict || 'triggered')
      if (d.since && d.to_gnb) {
        watching.current = { since: d.since, to: d.to_gnb }
        giveUpAtRef.current = Date.now() + 180_000
        setHoOutcome({ state: 'in_progress', detail: `to gNB ${d.to_gnb}…` })
      }
    } catch {
      setNote('could not reach the backend')
    } finally {
      setBusy(null)
    }
  }, [])

  const polling = hoOutcome?.state === 'in_progress'
  useEffect(() => {
    if (!polling) return
    let alive = true
    const iv = setInterval(async () => {
      const w = watching.current
      if (!w) return
      if (Date.now() > giveUpAtRef.current) {
        setHoOutcome({ state: 'unknown',
          detail: 'timed out' })
        return
      }
      try {
        const r = await fetch(
          `/api/ran/ho/outcome?since=${encodeURIComponent(w.since)}&to_gnb=${w.to}`,
          { headers: authHeader() })
        const d = await r.json()
        if (!alive || !d?.ok) return
        setHoOutcome({ state: d.state, detail: d.detail, reason: d.reason })
      } catch {  }
    }, 2000)
    return () => { alive = false; clearInterval(iv) }
  }, [polling])

  const g1 = status?.gnb1 ?? EMPTY_CELL
  const g2 = status?.gnb2 ?? EMPTY_CELL
  const ueUp = !!status?.ue_listening
  const serving = status?.serving_gnb ?? null
  const channelOn = !!live?.running
  const anythingUp = channelOn || ueUp || g1.running || g2.running
  const moving = walked > 1
  const wedged: number[] = (status as any)?.wedged_cells ?? []
  const dropped = !!(((g1.running || g2.running) && !serving) || wedged.length > 0)

  async function doReconnect() {
    setBusy('reconnect')
    setNote('')
    try {
      const r = await fetch('/api/ran/ho/reconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ wait: false }),
      })
      if (r.status === 401) { setNote('session expired'); return }
      const b = await r.json().catch(() => ({}))
      if (b?.ok) {
        setNote('reconnecting…')
        window.setTimeout(() => setBusy(null), 45000)
        return
      }
      setNote(b?.error || 'reconnect failed')
    } catch (e: any) {
      setNote(String(e?.message || e))
      setBusy(null)
      return
    }
    setBusy(null)
  }

  const canHandover = !!(serving && g1.running && g2.running && moving)

  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column',
                  background: '#EEF3F4', color: T.ink }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 22px', flex: '0 0 auto',
                    background: 'linear-gradient(135deg, rgba(255,255,255,.72) 0%, rgba(255,255,255,.56) 45%, rgba(255,255,255,.48) 100%)',
                    backdropFilter: 'blur(14px) saturate(155%)',
                    WebkitBackdropFilter: 'blur(14px) saturate(155%)',
                    borderBottom: '1px solid rgba(226,233,234,.85)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 6px 18px rgba(24,52,66,.06)',
                    position: 'relative', zIndex: 3 }}>
        <span style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-.4px' }}>Simulation</span>
        <Tag>2 × gNB · Xn · SD-Core</Tag>
        {scene && <Tag muted>{scene.city || scene.scene_id}</Tag>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="sk-btn-ghost"
            onClick={() => nav(scene?.scene_id
              ? `/builder?scene=${encodeURIComponent(scene.scene_id)}`
              : '/builder')}>
            <Icon.builder size={16} stroke="#3B4C54" /> Back to Builder
          </button>
          <UserChip />
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: '#0E1820' }}>
          <iframe
            ref={iframeRef} src={MAP_URL} title="scene-map" allow="geolocation"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }}
          />
        </div>

        <button
          onClick={() => setPanelFolded((v) => !v)}
          title={panelFolded ? 'Show panel' : 'Hide panel'}
          aria-label={panelFolded ? 'Show panel' : 'Hide panel'}
          style={{
            position: 'absolute', zIndex: 3,
            top: '50%', marginTop: -PANEL_TAB_H / 2,
            right: panelFolded ? 0 : PANEL_W + PANEL_INSET,
            transition: 'right .22s ease',
            width: PANEL_TAB_W, height: PANEL_TAB_H, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontFamily: 'inherit',
            borderRadius: '8px 0 0 8px',
            border: '1px solid rgba(226,233,234,.9)', borderRight: 'none',
            background: 'rgba(255,255,255,.93)',
            backdropFilter: 'blur(14px) saturate(150%)',
            WebkitBackdropFilter: 'blur(14px) saturate(150%)',
            boxShadow: '0 4px 14px rgba(24,52,66,.12)',
            color: T.mut,
          }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: panelFolded ? 'none' : 'rotate(180deg)' }}>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>

        <div style={{
          position: 'absolute', top: PANEL_INSET, right: PANEL_INSET, bottom: PANEL_INSET,
          width: PANEL_W, overflowY: 'auto', borderRadius: 14,
          transform: panelFolded
            ? `translateX(calc(100% + ${PANEL_INSET * 2}px))` : 'none',
          transition: 'transform .22s ease',
          pointerEvents: panelFolded ? 'none' : 'auto',
          background: 'rgba(255,255,255,.93)', backdropFilter: 'blur(14px) saturate(150%)',
          WebkitBackdropFilter: 'blur(14px) saturate(150%)',
          border: '1px solid rgba(226,233,234,.9)',
          boxShadow: '0 10px 30px rgba(24,52,66,.10)', padding: 16, zIndex: 2,
        }}>
          <div style={{ marginBottom: S.md }}>
            <div style={{ fontSize: 12, color: T.mut, fontWeight: 700, letterSpacing: '.3px' }}>
              SERVING CELL
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: 30, fontWeight: 800,
                             color: serving ? '#327985' : T.dim, letterSpacing: '-.5px' }}>
                {serving ? `gNB ${serving}` : '—'}
              </span>
              {serving && (
                <span style={{ fontSize: 13, color: T.mut, fontWeight: 700 }}>
                  {status?.serving_pci == null ? 'PCI —' : `PCI ${status.serving_pci}`}
                  {' · '}{(serving === 1 ? g1 : g2).rnti ?? 'no rnti'}
                </span>
              )}
            </div>
            {!serving && <Hint>No serving cell</Hint>}
          </div>

          <div style={{ marginBottom: S.md }}>
            <div style={{ fontSize: 11, color: T.mut, fontWeight: 700, letterSpacing: '.3px',
                          marginBottom: 4 }}>
              SCENE
            </div>
            <select
              value={scene?.scene_id ?? ''}
              onChange={(e) => {
                const next = scenes.find((x) => x.scene_id === e.target.value) ?? null
                setScene(next)
                loadedRef.current = null
                setHoOutcome(null)
                setNote(null)
              }}
              style={{
                width: '100%', padding: '7px 9px', borderRadius: 8, fontSize: 12.5,
                fontWeight: 650, color: T.ink, background: '#fff',
                border: '1px solid ' + T.bd, cursor: 'pointer',
              }}
            >
              {scenes.length === 0 && <option value="">no built scenes</option>}
              {scenes.map((sc) => (
                <option key={sc.scene_id} value={sc.scene_id}>
                  {sc.name || sc.city || sc.scene_id}
                  {sc.name && sc.city ? ` · ${sc.city}` : ''}
                  {sc.nof_gnb != null ? ` — ${sc.nof_gnb} gNB` : ''}
                </option>
              ))}
            </select>
            {scene && scene.nof_gnb != null && scene.nof_gnb < 2 && (
              <Hint tone="warn">
                {scene.nof_gnb} gNB · needs 2
              </Hint>
            )}
          </div>

          <Section n={1} title="Start" open={step === 'up'} onToggle={() => setStep('up')}>
            <div style={{ display: 'flex', gap: 8, marginTop: S.sm }}>
              <StackBtn
                label={ueUp ? 'UE listening' : 'Start UE'}
                on={ueUp}
                busy={busy === 'ue'}
                disabled={ueUp}
                onClick={() => act('ue', '/api/ran/ho/ue/start')}
              />
              <StackBtn
                label={channelOn ? 'Sionna streaming' : 'Start Sionna'}
                on={channelOn}
                busy={busy === 'sionna'}
                disabled={channelOn || !scene}
                onClick={startSionna}
              />
            </div>
            {note && (
              <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 650, lineHeight: 1.45,
                            color: /could not|failed|not running|no cell|using :4043|already/i
                              .test(note) ? '#B07908' : '#327985' }}>
                {note}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              {[1, 2].map((n) => {
                const c = n === 1 ? g1 : g2
                return (
                  <StackBtn
                    key={n}
                    label={c.running ? `gNB ${n} up` : `Start gNB ${n}`}
                    on={c.running}
                    busy={busy === `gnb${n}`}
                    disabled={c.running || !ueUp}
                    title={!ueUp ? 'Start UE first' : undefined}
                    onClick={() => act(`gnb${n}`, `/api/ran/ho/gnb/${n}/start`)}
                  />
                )
              })}
            </div>

            <button
              className="sk-btn-ghost"
              onClick={stopEverything}
              disabled={busy === 'stop' || !anythingUp}
              style={{
                marginTop: 10, width: '100%', justifyContent: 'center',
                border: '1px solid ' + (anythingUp ? '#E7C9C9' : T.bd),
                color: anythingUp ? '#A5453F' : T.dim,
                fontWeight: 750,
                cursor: anythingUp ? 'pointer' : 'default',
              }}
            >
              {busy === 'stop' ? 'Stopping…' : 'Stop all'}
            </button>
          </Section>

          <Section n={2} title="Cells" open={step === 'cells'} onToggle={() => setStep('cells')}>
            {[1, 2].map((n) => {
              const c = n === 1 ? g1 : g2
              return (
                <div key={n} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '7px 0',
                  borderTop: n === 2 ? '1px solid ' + T.bd : 'none',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
                    background: serving === n ? '#327985' : c.running ? '#3FBF7F' : T.dim,
                  }} />
                  <span style={{ fontSize: 13, fontWeight: 750, minWidth: 52 }}>gNB {n}</span>
                  <span style={{ fontSize: 12, color: c.pci == null ? T.dim : T.mut,
                                 fontWeight: 600 }}>
                    {c.pci == null ? 'PCI —' : `PCI ${c.pci}`}
                  </span>
                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    <Pill on={c.amf} label="core" />
                    <Pill on={c.xn} label="Xn" />
                    <Pill on={serving === n} label="serving" />
                  </span>
                </div>
              )
            })}
          </Section>

          <Section n={3} title="Handover" open={step === 'ho'} onToggle={() => setStep('ho')}>
            {wedged.length > 0 && (
              <div style={{
                marginBottom: 8, padding: '8px 10px', borderRadius: 8, fontSize: 11.5,
                lineHeight: 1.5, fontWeight: 600, background: '#FBEDEA', color: '#A5453F',
              }}>
                <div style={{ fontWeight: 800, marginBottom: 2 }}>
                  gNB {wedged.join(' and gNB ')} {wedged.length > 1 ? 'have' : 'has'} stopped responding
                </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="sk-btn-ghost"
                onClick={doHandover}
                disabled={!canHandover || busy === 'trigger'
                          || hoOutcome?.state === 'in_progress'}
                title={canHandover ? undefined
                  : !serving ? 'No serving cell'
                  : !moving ? 'UE not moving'
                  : 'Both cells must be up'}
                style={{
                  flex: 1, justifyContent: 'center',
                  border: '1px solid ' + (canHandover ? '#BAE1E8' : T.bd),
                  color: canHandover ? '#327985' : T.dim,
                  fontWeight: 800,
                  cursor: canHandover ? 'pointer' : 'default',
                }}
              >
                {busy === 'trigger' ? 'Handing over…'
                  : serving ? `Hand over to gNB ${serving === 1 ? 2 : 1}` : 'Handover'}
              </button>
              {dropped && (
                <button
                  className="sk-btn-ghost"
                  onClick={doReconnect}
                  disabled={!!busy}
                  style={{
                    flex: 1, justifyContent: 'center',
                    border: '1px solid #E8C99B',
                    color: '#8A6A2F',
                    fontWeight: 800,
                    cursor: busy ? 'default' : 'pointer',
                  }}
                >
                  {busy === 'reconnect' ? 'Reconnecting…' : 'Reconnect Process'}
                </button>
              )}
            </div>
            {hoOutcome && (
              <div style={{
                marginTop: 8, padding: '8px 10px', borderRadius: 8, fontSize: 11.5,
                lineHeight: 1.5, fontWeight: 600,
                background: hoOutcome.state === 'completed' ? '#EAF6EF'
                          : hoOutcome.state === 'failed' ? '#FBEDEA'
                          : hoOutcome.state === 'unknown' ? '#FAF6EC' : '#EFF5F6',
                color: hoOutcome.state === 'completed' ? '#1E6B45'
                     : hoOutcome.state === 'failed' ? '#A5453F'
                     : hoOutcome.state === 'unknown' ? '#8A6D1F' : '#4A6472',
                border: '1px solid ' + (hoOutcome.state === 'completed' ? '#C6E6D3'
                                      : hoOutcome.state === 'failed' ? '#EDD2CD'
                                      : hoOutcome.state === 'unknown' ? '#E8DDBE' : '#DCE5E9'),
              }}>
                <div style={{ fontWeight: 800, marginBottom: 2 }}>
                  {hoOutcome.state === 'completed' ? 'Handover completed'
                   : hoOutcome.state === 'failed' ? 'Handover failed'
                   : hoOutcome.state === 'unknown' ? 'Handover outcome unknown'
                   : 'Handover in progress…'}
                </div>
                {hoOutcome.detail}
              </div>
            )}
            {note && (
              <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 650,
                            color: /could not|failed|not running|no cell/i.test(note)
                              ? '#B07908' : '#327985' }}>
                {note}
              </div>
            )}
            {!moving && serving && <Hint>UE not moving</Hint>}
          </Section>

          <Section n={4} title="Status" open={step === 'watch'} onToggle={() => setStep('watch')}>
            <Readout label="Cells up" value={`${[g1, g2].filter((c) => c.running).length} of 2`} />
            <Readout label="Channel" value={channelOn ? 'streaming' : 'idle'} />
            <Readout label="UE" value={ueUp ? 'listening on :4043' : 'not running'} />
            <Readout label="Walked" value={`${walked.toFixed(0)} m`} />
            <Readout label="On the map"
                     value={serving ? `link to gNB ${serving}` : 'no link'} />
          </Section>
        </div>
      </div>
    </div>
  )
}

function StackBtn({ label, on, busy, disabled, title, onClick }: {
  label: string; on: boolean; busy: boolean; disabled?: boolean
  title?: string; onClick: () => void
}) {
  return (
    <button
      className="sk-btn-ghost"
      onClick={onClick}
      disabled={!!disabled || busy}
      title={title}
      style={{
        flex: 1, justifyContent: 'center', fontWeight: 750, fontSize: 12.5,
        border: '1px solid ' + (on ? '#BFE6D3' : T.bd),
        background: on ? 'rgba(63,191,127,.08)' : 'transparent',
        color: on ? '#2E7D55' : disabled ? T.dim : '#3B4C54',
        cursor: disabled ? 'default' : 'pointer',
      }}
    >
      {busy ? 'Starting…' : label}
    </button>
  )
}

function Pill({ on, label }: { on: boolean; label: string }) {
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 750, padding: '2px 7px', borderRadius: 999,
      background: on ? 'rgba(13,122,140,.10)' : 'rgba(0,0,0,.04)',
      color: on ? '#327985' : T.dim,
    }}>
      {label}
    </span>
  )
}
