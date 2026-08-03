import { UserChip } from '../components/TopBar'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { authHeader, getToken } from '../lib/auth'
import { useNavigate } from 'react-router-dom'
import { mapApi, isError, type SceneMeta, type DuConfig } from '../lib/mapApi'
import { RanPanel, Ladder, type Stage, type UeStatus } from './RanPanel'
import { SimServers, useSimState, type SimDeployment } from './SimServers'
import { RanConsole, type LogSource } from './RanConsole'
import { Icon } from '../components/Icon'
import { T, S, Section, FieldLabel, Readout, SelectField, Hint, Empty, Tag, MenuItem } from './panelKit'

const LAST_SCENE_KEY = 'tossi.raytrace.lastScene'
const TWIN_SCENE_KEY = 'tossi.twin.lastScene'

const MAP_URL = `/sionna-map/index.html?v=${Date.now()}&chrome=operate`

const CONTEXT_KM = 1

const PANEL_W = 408
const PANEL_INSET = 12
const PANEL_TAB_W = 22
const PANEL_TAB_H = 44

export function ScreenSimulation() {
  const nav = useNavigate()
  const [scenes, setScenes] = useState<SceneMeta[]>([])
  const [duConfigs, setDuConfigs] = useState<DuConfig[]>([])
  const [sceneId, setSceneId] = useState<string | null>(
    () => localStorage.getItem(LAST_SCENE_KEY)
          ?? localStorage.getItem(TWIN_SCENE_KEY))
  const [duPath, setDuPath] = useState('')
  const sim = useSimState()
  const [simPick, setSimPick] = useState<SimDeployment | null>(null)
  useEffect(() => {
    if (!sim) return
    const now = sim.deployments.find((x) => x.running) ?? null
    setSimPick((p) => now ?? (p && sim.deployments.find((x) => x.id === p.id)) ?? sim.deployments[0] ?? null)
  }, [sim])
  const [savedDu, setSavedDu] = useState<string | null>(null)

  useEffect(() => {
    mapApi.scenes().then((s) => Array.isArray(s) && setScenes(s.filter((x) => x.built)))
    mapApi.duConfigs().then((d) => Array.isArray(d) && setDuConfigs(d))
  }, [])

  const scene = useMemo(() => scenes.find((s) => s.scene_id === sceneId) ?? null, [scenes, sceneId])

  const [names, setNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let live = true
    Promise.all(scenes.slice(0, 24).map((s) =>
      fetch(`/api/map/scenes/${s.scene_id}/config`, { headers: authHeader() }).then((r) => (r.ok ? r.json() : null))
        .then((c) => [s.scene_id, c?.name] as const).catch(() => [s.scene_id, null] as const)))
      .then((pairs) => {
        if (!live) return
        const m: Record<string, string> = {}
        pairs.forEach(([id, n]) => { if (n) m[id] = n })
        setNames(m)
      })
    return () => { live = false }
  }, [scenes])

  useEffect(() => {
    if (!sceneId) return
    fetch(`/api/map/scenes/${sceneId}/du-configs`, { headers: authHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (Array.isArray(d)) setDuConfigs(d) })
      .catch(() => {})
  }, [sceneId])

  useEffect(() => {
    if (!sceneId) return
    localStorage.setItem(LAST_SCENE_KEY, sceneId)
    localStorage.setItem(TWIN_SCENE_KEY, sceneId)
    fetch(`/api/map/scenes/${sceneId}/config`, { headers: authHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((c) => {
        const cfg = c?.du_config ?? ''
        setSavedDu(cfg || null)
        setDuPath(cfg || (duConfigs[0]?.path ?? ''))
      })
      .catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneId, duConfigs.length])

  const iframeRef = useRef<HTMLIFrameElement | null>(null)
  const [mapReady, setMapReady] = useState(false)
  const loadedRef = useRef<string | null>(null)

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, window.location.origin)
  }, [])

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== window.location.origin) return
      if ((e.data || {}).type === 'sk-ready') {
        setMapReady(true)
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'sk-auth', token: getToken() ?? '' }, window.location.origin)
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'sk-serving', pci: null }, window.location.origin)
        iframeRef.current?.contentWindow?.postMessage(
          { type: 'sk-inset', right: PANEL_W + PANEL_INSET * 2 }, window.location.origin)
      }
      if ((e.data || {}).type === 'sk-rays-toggled') {
        setRaysOn(!!(e.data || {}).on)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  useEffect(() => {
    if (!mapReady || !sceneId || loadedRef.current === sceneId) return
    loadedRef.current = sceneId
    let live = true
    void (async () => {
      const pkg = await mapApi.scenePackage(sceneId)
      if (!live || isError(pkg)) return
      post({ type: 'sk-load-manifest', manifest: pkg.manifest ?? pkg, padKm: CONTEXT_KM, lock: true })
      const c = await mapApi.sceneCoverage(sceneId)
      if (live && !isError(c) && c.overlay) post({ type: 'sk-load-coverage', overlay: c.overlay })
    })()
    return () => { live = false }
  }, [mapReady, sceneId, post])

  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!menuFor) return
    const close = () => { setMenuFor(null); setConfirmDel(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [menuFor])

  const [live, setLive] = useState<LiveStatus | null>(null)
  const routeRef = useRef<{ positions: number[][]; steps: number; loop: boolean } | null>(null)
  const routeForRef = useRef<string | null>(null)
  const lastSeqRef = useRef<number | null>(null)
  const [txPowerDbm, setTxPowerDbm] = useState<number | null>(null)
  const [raysOn, setRaysOn] = useState(true)

  useEffect(() => {
    if (!sceneId && live?.running && live.scene_id) setSceneId(live.scene_id)
  }, [sceneId, live?.running, live?.scene_id])

  const org = useMemo(() => {
    const id = live?.running ? live.scene_id : null
    const s = id ? scenes.find((x) => x.scene_id === id) : null
    return s?.origin_lonlat ?? scene?.origin_lonlat ?? null
  }, [live?.running, live?.scene_id, scenes, scene?.origin_lonlat])

  const savedRays = useMemo(() => {
    const id = live?.running ? live.scene_id : null
    const src = (id ? scenes.find((x) => x.scene_id === id) : null) ?? scene
    return ((src?.trace as { links?: { path_detail?: { points?: number[][] }[] }[] } | undefined)
      ?.links ?? []).flatMap((l) => l.path_detail ?? [])
      .filter((p) => (p.points ?? []).length > 1)
  }, [live?.running, live?.scene_id, scenes, scene])

  useEffect(() => {
    if (!raysOn) { post({ type: 'sk-hide-rays' }); return }
    if (!mapReady) return
    if (savedRays.length && org) {
      post({ type: 'sk-load-rays', paths: savedRays, origin_lonlat: org })
    }
    post({ type: 'sk-show-rays' })
  }, [raysOn, mapReady, savedRays, org, live?.running])

  useEffect(() => {
    if (!raysOn || !mapReady || !org || !live?.running) return
    let alive = true
    const STALE_S = 4
    const tick = async () => {
      try {
        const r = await fetch('/api/map/live/rays', { headers: authHeader() })
        const d = await r.json()
        if (!alive) return
        const paths = d?.rays?.path_detail
        const fresh = d?.age_s != null && d.age_s <= STALE_S
        if (fresh && !paths?.length) { post({ type: 'sk-hide-rays' }); return }
        if (!paths?.length || !fresh) return
        const walking = live?.moving === true
        const bg = walking ? [] : savedRays.map((p) => ({ ...p, bg: true }))
        post({ type: 'sk-load-rays', paths: [...bg, ...paths], origin_lonlat: org })
        post({ type: 'sk-show-rays' })
      } catch {  }
    }
    const id = window.setInterval(() => { void tick() }, 1200)
    void tick()
    return () => { alive = false; window.clearInterval(id) }
  }, [raysOn, mapReady, org, live?.running, live?.moving, savedRays])

  const [walked, setWalked] = useState(0)
  const lastPosRef = useRef<number[] | null>(null)

  const liveScene = live?.scene_id ?? null
  useEffect(() => {
    if (!liveScene) { setTxPowerDbm(null); return }
    let alive = true
    void (async () => {
      try {
        const r = await fetch(`/api/map/scenes/${liveScene}/radio`, { headers: authHeader() })
        const d = await r.json()
        if (!alive) return
        const tx = (d?.transmitters ?? [])
          .map((t: { from_design?: { tx_power_dbm?: number } }) => t?.from_design?.tx_power_dbm)
          .find((v: number | undefined) => typeof v === 'number')
        setTxPowerDbm(typeof tx === 'number' ? tx : null)
      } catch { setTxPowerDbm(null) }
    })()
    return () => { alive = false }
  }, [liveScene])

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/map/live/status', { headers: authHeader() })
        const d = (await r.json()) as LiveStatus
        if (!alive) return
        if (!isOurs(d)) {
          setLive(null)
          if (routeForRef.current) { routeForRef.current = null; routeRef.current = null }
          post({ type: 'sk-live-ue', enu: null })
          lastPosRef.current = null
          return
        }
        setLive(d)
        if (!d.running) {
          if (routeForRef.current) { routeForRef.current = null; routeRef.current = null; post({ type: 'sk-live-ue', enu: null }) }
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
          const rr = await fetch('/api/map/live/route', { headers: authHeader() }).then((x) => x.json()).catch(() => null)
          if (alive && rr?.route?.positions) routeRef.current = rr.route
        }
        const seq = d.last?.seq
        if (seq == null) return
        const pos = positionFor(seq, routeRef.current, d.last?.pos)
        if (pos) {
          const prev = lastPosRef.current
          if (prev) {
            const step = Math.hypot(pos[0] - prev[0], pos[1] - prev[1])
            if (step > 0.01) setWalked((w) => w + step)
          }
          lastPosRef.current = pos
          post({ type: 'sk-live-ue', enu: pos,
            gain_db: d.last?.gain_db, applied_db: d.last?.applied_db, paths: d.last?.paths })
        }
        if (seq !== lastSeqRef.current) { lastSeqRef.current = seq; captureFrame() }
      } catch {  }
    }
    void pull()
    const iv = setInterval(pull, 1000)
    return () => { alive = false; clearInterval(iv) }
  }, [post])

  const [panelFolded, setPanelFolded] = useState(() => {
    const saved = localStorage.getItem('tossi.raytrace.panelFolded')
    return saved === null ? true : saved === '1'
  })
  useEffect(() => {
    localStorage.setItem('tossi.raytrace.panelFolded', panelFolded ? '1' : '0')
    post({ type: 'sk-inset', right: panelFolded ? PANEL_TAB_W + PANEL_INSET * 2
                                                : PANEL_W + PANEL_INSET * 2 })
  }, [panelFolded, post])

  const [recId, setRecId] = useState<string | null>(null)
  const recRef = useRef<string | null>(null)
  const frameSeq = useRef(0)
  const framePending = useRef(false)
  const framePendingAt = useRef(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = await fetch('/api/recordings/open', { headers: authHeader() })
        if (!r.ok) return
        const d = await r.json()
        if (!alive || !d?.id || recRef.current) return
        recRef.current = d.id
        setRecId(d.id)
      } catch {  }
    })()
    return () => { alive = false }
  }, [])

  const startRecording = useCallback(async (label?: string) => {
    if (recRef.current || !sceneId) return
    try {
      const r = await fetch('/api/recordings/start', {
        method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ scene_id: sceneId, du_config: duPathRef.current, label }),
      })
      const d = await r.json()
      if (d?.id) { recRef.current = d.id; setRecId(d.id) }
    } catch {  }
  }, [sceneId])

  const clearRunOverlays = useCallback(() => {
    post({ type: 'sk-hide-rays' })
    setRaysOn(false)
  }, [post])

  const stopRecording = useCallback(async () => {
    const id = recRef.current
    if (!id) return
    recRef.current = null
    setRecId(null)
    try {
      await fetch(`/api/recordings/${id}/stop`, { method: 'POST',
        headers: { ...authHeader(), 'Content-Type': 'application/json' }, body: '{}' })
    } catch {  }
  }, [])

  const FRAME_TIMEOUT_MS = 4000
  const captureFrame = useCallback(() => {
    if (!recRef.current) return
    const now = Date.now()
    if (framePending.current && now - framePendingAt.current < FRAME_TIMEOUT_MS) return

    const id = ++frameSeq.current
    framePending.current = true
    framePendingAt.current = now

    const onFrame = (e: MessageEvent) => {
      const d = e.data || {}
      if (e.origin !== window.location.origin || d.type !== 'sk-frame' || d.requestId !== id) return
      window.removeEventListener('message', onFrame)
      if (frameSeq.current === id) framePending.current = false
      const run = recRef.current
      if (!run || !d.image) return
      void fetch(`/api/recordings/${run}/frame`, {
        method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: d.image }),
      }).catch(() => {})
    }
    window.addEventListener('message', onFrame)
    post({ type: 'sk-capture', requestId: id })
    window.setTimeout(() => {
      window.removeEventListener('message', onFrame)
      if (frameSeq.current === id) framePending.current = false
    }, FRAME_TIMEOUT_MS)
  }, [post])

  const [kpi, setKpi] = useState<CellKpi | null>(null)
  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await fetch('/api/ran/kpi?samples=60', { headers: authHeader() })
        const d = (await r.json()) as CellKpi
        if (alive) setKpi(d)
      } catch {  }
    }
    void pull()
    const iv = setInterval(pull, 2000)
    return () => { alive = false; clearInterval(iv) }
  }, [])

  const [logSource, setLogSource] = useState<LogSource>('du')
  const [showLog, setShowLog] = useState(false)
  const onStarted = useCallback((s: LogSource) => {
    setLogSource(s); setShowLog(true)
    post({ type: 'sk-fold-controls' })
    void startRecording(`${s} started`)
  }, [startRecording, post])

  const [ran, setRan] = useState<{ stages: Stage[]; busy: boolean; ue: UeStatus | null } | null>(null)

  const [step, setStep] = useState<string>('ran')
  const openStep = (k: string) => setStep((cur) => (cur === k ? '' : k))

  const openScene = (id: string) => { setSceneId(id); setMenuFor(null); setStep('ran') }

  const editScene = (id: string) => { setMenuFor(null); nav(`/builder?scene=${encodeURIComponent(id)}`) }

  const deleteScene = async (id: string) => {
    const r = await mapApi.deleteScene(id)
    if (isError(r)) { setErr(r.error); setMenuFor(null); setConfirmDel(null); return }
    if (sceneId === id) { setSceneId(null); loadedRef.current = null }
    for (const k of [LAST_SCENE_KEY, TWIN_SCENE_KEY, 'tossi.handover.lastScene'])
      if (localStorage.getItem(k) === id) localStorage.removeItem(k)
    setScenes((cur) => cur.filter((s) => s.scene_id !== id))
    setNames((cur) => { const m = { ...cur }; delete m[id]; return m })
    setMenuFor(null); setConfirmDel(null); setErr(null)
  }

  const duPathRef = useRef('')
  useEffect(() => { duPathRef.current = duPath }, [duPath])

  const overridden = duPath !== (savedDu ?? '')
  const du = duConfigs.find((d) => d.path === duPath) ?? null
  const sceneLabel = scene ? (names[scene.scene_id] ?? scene.city ?? scene.scene_id) : null

  const saveConfig = () => {
    if (!sceneId) return
    fetch(`/api/map/scenes/${sceneId}/config`, {
      method: 'POST', headers: { ...authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ du_config: duPath }),
    }).then(() => setSavedDu(duPath)).catch(() => {})
  }

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
        <Tag>CU · DU · Sionna · UE</Tag>
        {sceneLabel && <Tag muted>{sceneLabel}</Tag>}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="sk-btn-ghost" onClick={() => nav('/builder')}>
            <Icon.builder size={16} stroke="#3B4C54" /> Back to Builder
          </button>
          <UserChip />
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        <div style={{ position: 'absolute', inset: 0, background: '#0E1820' }}>
          {sceneId ? (
            <iframe ref={iframeRef} title="scene-map" src={MAP_URL} allow="geolocation"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 'none' }} />
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
                          justifyContent: 'center', color: '#7E939C', fontSize: 15, fontWeight: 600 }}>
              No scene
            </div>
          )}

          {showLog
            ? <RanConsole source={logSource} onSource={setLogSource} onClose={() => setShowLog(false)}
                sceneId={sceneId ?? undefined}
                left={PANEL_INSET} right={PANEL_W + PANEL_INSET * 2} />
            : (
              <button onClick={() => setShowLog(true)}
                style={{ position: 'absolute', left: PANEL_INSET, bottom: PANEL_INSET, zIndex: 6,
                         border: '1px solid rgba(255,255,255,.16)', borderRadius: 10,
                         background: 'rgba(34,48,63,.86)', color: '#E9F0F6',
                         backdropFilter: 'blur(12px) saturate(150%)',
                         WebkitBackdropFilter: 'blur(12px) saturate(150%)',
                         padding: '7px 13px', fontSize: 12.5, fontWeight: 700,
                         cursor: 'pointer', fontFamily: 'inherit' }}>
                Show logs
              </button>
            )}
        </div>

        <button
          onClick={() => setPanelFolded((v) => !v)}
          title={panelFolded ? 'Show panel' : 'Hide panel'}
          aria-label={panelFolded ? 'Show panel' : 'Hide panel'}
          style={{
            position: 'absolute', zIndex: 7,
            top: '50%', marginTop: -PANEL_TAB_H / 2,
            right: panelFolded ? 0 : PANEL_W + PANEL_INSET,
            transition: 'right .22s ease',
            width: PANEL_TAB_W, height: PANEL_TAB_H, padding: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontFamily: 'inherit',
            borderRadius: '8px 0 0 8px',
            border: '1px solid rgba(255,255,255,.7)', borderRight: 'none',
            background: T.panel,
            backdropFilter: 'blur(16px) saturate(160%)',
            WebkitBackdropFilter: 'blur(16px) saturate(160%)',
            boxShadow: '0 4px 14px rgba(24,52,66,.16)',
            color: T.mut,
          }}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: panelFolded ? 'none' : 'rotate(180deg)' }}>
            <path d="M10 3 5 8l5 5" />
          </svg>
        </button>

        <div style={{ position: 'absolute', top: PANEL_INSET, right: PANEL_INSET,
                      maxHeight: `calc(100% - ${PANEL_INSET * 2}px)`,
                      width: PANEL_W, overflow: 'hidden',
                      transform: panelFolded
                        ? `translateX(calc(100% + ${PANEL_INSET * 2}px))` : 'none',
                      transition: 'transform .22s ease',
                      pointerEvents: panelFolded ? 'none' : 'auto',
                      color: T.ink, borderRadius: 16,
                      display: 'flex', flexDirection: 'column',
                      background: T.panel,
                      backdropFilter: 'blur(16px) saturate(160%)',
                      WebkitBackdropFilter: 'blur(16px) saturate(160%)',
                      border: '1px solid rgba(255,255,255,.65)',
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,.9), 0 12px 34px rgba(24,52,66,.18)' }}>
          {sceneId && ran && (
            <div style={{ flex: '0 0 auto', padding: `${S.md}px ${S.lg}px ${S.sm}px`,
                          background: 'rgba(255,255,255,.55)',
                          borderBottom: '1px solid ' + T.bd,
                          boxShadow: '0 1px 0 rgba(255,255,255,.7)' }}>
              <Ladder stages={ran.stages} busy={ran.busy} />
              <HeroRow live={live} route={routeRef.current} kpi={kpi} walked={walked} />
            </div>
          )}

          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden' }}>
          {err && (
            <div style={{ margin: S.md, padding: '9px 12px', borderRadius: 10,
                          border: '1px solid ' + T.badLine, background: '#FDF2F2',
                          color: T.bad, fontSize: 12.5, fontWeight: 600 }}>{err}</div>
          )}

          <Section n={1} title="Scene" open={step === 'scene'} onToggle={() => openStep('scene')}
            hint={scene ? `${scene.nof_gnb ?? 0} tx · ${scene.nof_ue ?? 0} UE` : `${scenes.length}`}
            summary={sceneLabel ?? (scenes.length ? 'none' : 'no scenes')}>
            {scenes.length === 0 ? (
              <Empty>No scenes</Empty>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: S.xs }}>
                {scenes.slice(0, 12).map((s) => {
                  const on = s.scene_id === sceneId
                  const open = menuFor === s.scene_id
                  return (
                    <div key={s.scene_id} style={{ position: 'relative' }}>
                      <div
                        onClick={(e) => {
                          e.stopPropagation()
                          setConfirmDel(null)
                          setMenuFor((cur) => (cur === s.scene_id ? null : s.scene_id))
                        }}
                        style={{ cursor: 'pointer', borderRadius: 10, padding: '9px 11px',
                                 border: '1px solid ' + (on || open ? T.bdBrand : T.bd),
                                 background: on ? T.fillBrand : '#fff' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', flex: '0 0 auto',
                                         background: on ? T.brand : T.dim }} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, fontWeight: 700,
                                         overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {names[s.scene_id] ?? s.city ?? 'Scene'}
                          </span>
                          <Chevron open={open} />
                        </div>
                        <div style={{ fontSize: 11, color: T.mut, fontWeight: 600, marginTop: 3,
                                      paddingLeft: 15 }}>
                          {s.nof_gnb ?? 0} gNB · {s.nof_ue ?? 0} UE
                          {s.has_coverage ? ' · coverage' : ''}{on ? ' · open' : ''}
                        </div>
                      </div>

                      {open && (
                        <div onClick={(e) => e.stopPropagation()}
                          style={{ position: 'absolute', top: 'calc(100% + 5px)', left: 0, right: 0, zIndex: 30,
                                   background: '#fff', border: '1px solid ' + T.bd, borderRadius: 11,
                                   boxShadow: '0 14px 34px rgba(14,26,32,.17)', padding: 5 }}>
                          <MenuItem label="Open"
                            onClick={() => openScene(s.scene_id)} />
                          <MenuItem label="Edit"
                            onClick={() => editScene(s.scene_id)} />
                          {confirmDel === s.scene_id ? (
                            <MenuItem label="Delete permanently" danger
                              onClick={() => deleteScene(s.scene_id)} />
                          ) : (
                            <MenuItem label="Delete" danger
                              onClick={() => setConfirmDel(s.scene_id)} />
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </Section>

          <Section n={2} title="Server" open={step === 'config'} onToggle={() => openStep('config')}
            hint={simPick ? simPick.servers.map((x) => x.nickname).join(' + ') : sim && !sim.deployments.length ? 'not deployed' : '—'}
            summary={simPick ? [simPick.servers.map((x) => x.nickname).join(' + '),
                               duPath.split('/').pop() || (live?.running ? live.params?.du_config : '')].filter(Boolean).join(' · ')
              : sim && !sim.deployments.length ? 'not deployed' : '—'}>
            <SimServers st={sim} pick={simPick} onPick={setSimPick} duPath={duPath} onDu={setDuPath} />
          </Section>

          <Section n={3} title="RAN" open={step === 'ran'} onToggle={() => openStep('ran')}
            hint="CU · DU · Sionna · UE">
            {!sceneId ? <Hint>No scene</Hint> : (
              <>
                <RanPanel duConfig={duPath || undefined} sceneId={sceneId} flat
                  platform={{ deployment: simPick, state: sim }}
                  hideLadder onState={setRan}
                  onStarted={onStarted} onStopped={stopRecording}
                  onCleanup={clearRunOverlays} />
                <RecordingRow id={recId} onStop={stopRecording}
                  onStart={() => startRecording('manual')} canStart={!!sceneId} />
                <RadioBlock live={live} route={routeRef.current} kpi={kpi} ue={ran?.ue ?? null}
                  txPowerDbm={txPowerDbm} />
              </>
            )}
          </Section>
          </div>
        </div>
      </div>
    </div>
  )
}

type KpiSample = {
  t?: string; ue: number; pci: number; rnti: string
  rsrp_db: number | null; snr_db: number | null; cqi: number | null
  dl_mcs: number | null; ul_mcs: number | null
  dl_prbs: number | null; ul_prbs: number | null
  dl_bler: number | null; ul_bler: number | null
  dl_kbps: number | null; ul_kbps: number | null
  dl_olla: number | null; dl_ok: number | null; dl_nok: number | null
}
type CellKpi = {
  du_running: boolean; du_is_ours: boolean
  ues: { ue: number; last: KpiSample; samples: KpiSample[]; age_s: number | null; fresh: boolean }[]
}

function RecordingRow({ id, onStop, onStart, canStart }: {
  id: string | null; onStop: () => void; onStart: () => void; canStart: boolean
}) {
  const nav = useNavigate()
  return (
    <div style={{ marginTop: S.md, paddingTop: S.md, borderTop: '1px solid ' + T.bd }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: T.mut,
                       letterSpacing: '.3px', textTransform: 'uppercase' }}>This run</span>
        <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.5px',
                       padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase',
                       color: id ? '#B3272C' : T.dim,
                       background: id ? 'rgba(179,39,44,.10)' : T.fill }}>
          {id ? 'Recording' : 'Idle'}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: 11.5, lineHeight: 1.45, color: T.mut,
                      fontWeight: 500 }}>
          <a onClick={() => nav('/runs')} style={{ cursor: 'pointer', fontWeight: 700 }}>
            Saved runs →
          </a>
        </div>
        {id
          ? <button className="sk-btn-ghost" onClick={onStop}
              style={{ padding: '5px 11px', fontSize: 12.5, flex: '0 0 auto' }}>Stop &amp; save</button>
          : <button className="sk-btn-ghost" disabled={!canStart} onClick={onStart}
              style={{ padding: '5px 11px', fontSize: 12.5, flex: '0 0 auto',
                       opacity: canStart ? 1 : 0.5 }}>Record</button>}
      </div>
    </div>
  )
}

const NO_PATH_FLOOR_DB = -250

function isMeasured(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > NO_PATH_FLOOR_DB
}

const GAIN_WINDOW: [number, number] = [-120, -60]
const SNR_WINDOW: [number, number] = [0, 40]

const RSS_THRESHOLD_DBM = -90

const PAIR_TOLERANCE_S = 4

const MIN_PAIRS = 25

const MIN_RESPONSE_DB = 1.0

function responseOf(traced: Pt[], measured: Pt[]): { traced: number; measured: number } | null {
  if (traced.length < 2 || measured.length < 2) return null
  const spread = (p: Pt[]) => {
    const v = p.map((x) => x.v)
    return Math.max(...v) - Math.min(...v)
  }
  return { traced: spread(traced), measured: spread(measured) }
}

function trackingR2(traced: Pt[], measured: Pt[]): { r2: number; n: number } | null {
  if (traced.length < 2 || measured.length < MIN_PAIRS) return null
  const xs: number[] = []
  const ys: number[] = []
  for (const m of measured) {
    let best: Pt | null = null
    let bestGap = Infinity
    for (const t of traced) {
      const gap = Math.abs(t.ago - m.ago)
      if (gap < bestGap) { bestGap = gap; best = t }
    }
    if (best && bestGap <= PAIR_TOLERANCE_S) { xs.push(best.v); ys.push(m.v) }
  }
  if (xs.length < MIN_PAIRS) return null

  const mean = (a: number[]) => a.reduce((p, c) => p + c, 0) / a.length
  const mx = mean(xs), my = mean(ys)
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy
  }
  if (sxx <= 0 || syy <= 0) return null
  const r = sxy / Math.sqrt(sxx * syy)
  return { r2: r * r, n: xs.length }
}

function spreadText(hz: number): string {
  if (hz <= 0) return '0 Hz'
  if (hz < 1) return `${Math.round(hz * 1000)} mHz`
  if (hz < 10) return `${hz.toFixed(1)} Hz`
  return `${Math.round(hz)} Hz`
}

function coherenceText(s: LiveSample): string {
  if (s.coherence_ms == null) return 'steady'
  const ms = s.coherence_ms < 10 ? s.coherence_ms.toFixed(1) : Math.round(s.coherence_ms)
  if (s.staleness == null) return `${ms} ms · ok`
  return `${ms} ms · ${Math.round(s.staleness)}× stale`
}

type LiveSample = {
  seq: number; pos?: number[]; gain_db?: number; applied_db?: number
  paths?: number; trace_ms?: number; t?: number
  doppler_hz?: number
  doppler_spread_hz?: number
  coherence_ms?: number
  staleness?: number
  doppler_steady?: boolean
}
function isOurs(d: LiveStatus | null): boolean {
  if (!d?.running) return true
  const owner = d.params?.owner
  return !owner || owner === 'raytrace'
}

type LiveStatus = {
  running: boolean; scene_id?: string; uptime_s?: number; updates?: number
  last?: LiveSample; samples?: LiveSample[]
  moving?: boolean
  params?: { mode?: string; owner?: string; du_config?: string; route?: Record<string, number | boolean> }
}
type LiveRoute = { positions: number[][]; steps: number; loop: boolean }

function positionFor(seq: number, route: LiveRoute | null, printed?: number[]): number[] | null {
  if (printed && printed.length >= 2) {
    if (route?.positions?.length) {
      let best = 0
      let bestD = Infinity
      for (let idx = 0; idx < route.positions.length; idx++) {
        const q = route.positions[idx]
        const d = (q[0] - printed[0]) ** 2 + (q[1] - printed[1]) ** 2
        if (d < bestD) { bestD = d; best = idx }
      }
      return route.positions[best]
    }
    return [printed[0], printed[1], 0]
  }

  if (!route?.positions?.length) return null
  const n = route.positions.length
  if (n === 1) return route.positions[0]
  let i: number
  if (route.loop) {
    const period = 2 * (n - 1)
    const k = ((seq % period) + period) % period
    i = k < n ? k : period - k
  } else {
    i = seq % n
  }
  return route.positions[Math.max(0, Math.min(n - 1, i))]
}

function RadioBlock({ live, route, kpi, ue: modem, txPowerDbm }: {
  live: LiveStatus | null; route: LiveRoute | null; kpi: CellKpi | null; ue: UeStatus | null
  txPowerDbm: number | null
}) {
  const s = live?.last
  const r = live?.params?.route as Record<string, number> | undefined
  const ue = kpi?.ues?.[0]
  const k = ue?.last
  const streaming = !!live?.running

  const rsrp = (ue?.samples ?? []).map((x) => x.rsrp_db).filter((v): v is number => v != null)
  const snr = (ue?.samples ?? []).map((x) => x.snr_db).filter((v): v is number => v != null)
  const gains = (live?.samples ?? []).map((x) => x.gain_db).filter(isMeasured)

  const livePts: Pt[] = (() => {
    const xs = (live?.samples ?? []).filter((x) => isMeasured(x.gain_db) && x.t != null)
    if (!xs.length) return []
    const newest = Math.max(...xs.map((x) => x.t as number))
    return xs.map((x) => ({ ago: newest - (x.t as number), v: x.gain_db as number }))
  })()

  const measuredPts: Pt[] = (() => {
    const xs = (ue?.samples ?? []).filter((x) => x.rsrp_db != null && x.t)
    if (!xs.length) return []
    const ms = xs.map((x) => Date.parse(x.t as string))
    if (ms.some((m) => Number.isNaN(m))) return []
    const newest = Math.max(...ms)
    const stale = ue?.age_s ?? 0
    return xs.map((x, i) => ({ ago: (newest - ms[i]) / 1000 + stale, v: x.rsrp_db as number }))
  })()

  const modemPts: Pt[] = (() => {
    const xs = (ue?.samples ?? []).filter((x) => x.snr_db != null && x.t)
    if (!xs.length) return []
    const ms = xs.map((x) => Date.parse(x.t as string))
    if (ms.some((m) => Number.isNaN(m))) return []
    const newest = Math.max(...ms)
    const stale = ue?.age_s ?? 0
    return xs.map((x, i) => ({ ago: (newest - ms[i]) / 1000 + stale, v: x.snr_db as number }))
  })()

  const histSpan = Math.max(
    ...livePts.map((p) => p.ago), ...modemPts.map((p) => p.ago), 1)

  const tracking = trackingR2(livePts, measuredPts)
  const response = responseOf(livePts, measuredPts)

  const gainMark = txPowerDbm != null
    ? { at: RSS_THRESHOLD_DBM - txPowerDbm,
        label: `${RSS_THRESHOLD_DBM} dBm edge` }
    : undefined

  const n = route?.positions?.length ?? 0
  if (!streaming && !k) {
    return (
      <div style={{ marginTop: S.md }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ flex: 1, fontSize: 11.5, fontWeight: 700, color: T.mut,
                         letterSpacing: '.3px', textTransform: 'uppercase' }}>Radio</span>
          <span style={{ fontSize: 9.5, fontWeight: 800, letterSpacing: '.5px',
                         padding: '2px 8px', borderRadius: 999, textTransform: 'uppercase',
                         color: T.dim, background: T.fill }}>Waiting</span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ marginTop: S.md }}>
      <FieldLabel>Radio</FieldLabel>

      {response && (
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 4,
                      flexWrap: 'wrap', padding: '6px 9px', borderRadius: 8,
                      background: T.fill, border: '1px solid ' + T.bd }}>
          <span style={{ fontSize: 11, fontWeight: 800,
                         color: response.measured >= MIN_RESPONSE_DB ? '#0B7A4B' : T.warn }}>
            {response.measured >= MIN_RESPONSE_DB ? 'RESPONDING' : 'BARELY MOVING'}
          </span>
          <span style={{ fontSize: 10, color: T.mut, fontWeight: 600 }}>
            traced {response.traced.toFixed(1)} dB · measured {response.measured.toFixed(1)} dB
          </span>
          {tracking && (
            <span style={{ fontSize: 10, fontWeight: 700,
                           color: tracking.r2 >= 0.7 ? '#0B7A4B' : tracking.r2 >= 0.4 ? T.warn : T.bad }}>
              · r² {tracking.r2.toFixed(2)} (n={tracking.n})
            </span>
          )}
        </div>
      )}

      {livePts.length > 1 && (
        <StackedSeries span={histSpan} series={[
          { name: 'traced gain', unit: 'dB', colour: T.brand, points: livePts,
            window: GAIN_WINDOW, mark: gainMark },
          ...(modemPts.length > 1
            ? [{ name: 'cell SNR (measured)', unit: 'dB', colour: T.warn, points: modemPts,
                 window: SNR_WINDOW }]
            : []),
        ]} />
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: S.md, marginTop: S.sm }}>
        <div style={{ minWidth: 0 }}>
          <ColHead live={streaming}>Tracer</ColHead>
          {streaming ? (
            <>
              <Readout label="Path gain" mono value={s?.gain_db != null ? `${s.gain_db.toFixed(1)} dB` : '—'} />
              <Readout label="Paths" value={s?.paths != null ? String(s.paths) : '—'} />
              <Readout label="Trace time" value={s?.trace_ms != null ? `${s.trace_ms} ms` : '—'} />
              <Readout label="Updates" value={`${live?.updates ?? 0} · ${Math.round(live?.uptime_s ?? 0)}s`} />
              {live?.params?.mode === 'route' && r && (
                <Readout label="Walking" value={`${r.length_m} m at ${r.speed_mps} m/s`} />
              )}
              {s?.doppler_hz != null && (
                <Readout label="Doppler shift" mono
                  value={`${s.doppler_hz > 0 ? '+' : ''}${s.doppler_hz.toFixed(0)} Hz`} />
              )}
              {s?.doppler_spread_hz != null && (
                <Readout label="Doppler spread" mono value={spreadText(s.doppler_spread_hz)} />
              )}
              {(s?.coherence_ms != null || s?.doppler_steady) && (
                <Readout label="Coherence" value={coherenceText(s)} />
              )}
            </>
          ) : <Hint>Not streaming</Hint>}
        </div>
        <div style={{ minWidth: 0 }}>
          <ColHead live={!!kpi?.du_running && !!ue?.fresh}>Radio</ColHead>
          {kpi?.du_running && ue && !ue.fresh && (
            <Hint tone="warn">STALE · {ue.age_s != null ? `${Math.round(ue.age_s)}s ago` : '—'}</Hint>
          )}
          <div style={{ opacity: modem?.sinr_stale ? 0.55 : 1 }}>
            <Readout label="SINR (dl, modem)" mono tone={modem?.sinr_stale ? 'warn' : 'ok'}
              value={modem?.sinr != null ? `${modem.sinr.toFixed(1)} dB`
                : modem?.sinr_stale ? `${modem.sinr_last_seen} dB · stale` : 'n/a'} />
          </div>
          {!kpi?.du_running ? (
            <Hint>Cell not running</Hint>
          ) : k ? (
            <div style={{ opacity: ue?.fresh ? 1 : 0.55 }}>
              <Readout label="RSRP (ul)" mono
                value={k.rsrp_db != null ? `${k.rsrp_db.toFixed(1)} dB` : 'n/a'} />
              <Readout label="SNR (ul)" mono
                value={k.snr_db != null ? `${k.snr_db.toFixed(1)} dB` : 'n/a'} />
              <Readout label="Link adaptation" tone="ok"
                value={k.dl_olla != null ? `olla ${k.dl_olla} · mcs ${k.dl_mcs ?? '—'}` : '—'} />
              <Readout label="Blocks ok / failed"
                value={`${k.dl_ok ?? '—'} / ${k.dl_nok ?? '—'}`}
                tone={(k.dl_nok ?? 0) > 0 ? 'warn' : undefined} />
              <Readout label="CQI" value={k.cqi != null ? String(k.cqi) : 'not reported'} />
              <Readout label="MCS dl/ul" value={`${k.dl_mcs ?? '—'} / ${k.ul_mcs ?? '—'}`} />
              <Readout label="Errors dl/ul"
                value={`${k.dl_bler != null ? k.dl_bler : '\u2014'}% / ${k.ul_bler != null ? k.ul_bler : '\u2014'}%`}
                tone={(k.dl_bler ?? 0) > 10 || (k.ul_bler ?? 0) > 10 ? 'warn' : undefined} />
            </div>
          ) : <Hint>No UE attached</Hint>}
        </div>
      </div>

      {live?.params?.mode === 'static' && streaming && (
        <Hint tone="warn">Static UE · 0 dB loss</Hint>
      )}
    </div>
  )
}

function HeroRow({ live, route, kpi, walked }: {
  live: LiveStatus | null; route: LiveRoute | null; kpi: CellKpi | null; walked: number
}) {
  const s = live?.last
  const r = live?.params?.route as Record<string, number> | undefined
  const k = kpi?.ues?.[0]?.last
  const n = route?.positions?.length ?? 0
  if (!live?.running) {
    return (
      <div style={{ marginTop: S.sm, fontSize: 12.5, color: T.mut, fontWeight: 600 }}>
        Channel idle
      </div>
    )
  }
  const attached = !!kpi?.ues?.length
  const sinrAbsent = !kpi?.du_running ? 'cell not running'
    : !attached ? 'no phone attached'
    : 'no uplink this period'

  const recent = (live?.samples ?? []).slice(-6).map((x) => x.pos).filter(Boolean) as number[][]
  const held = recent.length >= 4 && recent.every(
    (p) => Math.abs(p[0] - recent[0][0]) < 0.5 && Math.abs(p[1] - recent[0][1]) < 0.5)

  return (
    <div style={{ marginTop: S.sm }}>
      {held && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 7,
                      padding: '5px 8px', borderRadius: 8,
                      background: 'rgba(240,168,60,.14)', border: '1px solid #F3E2C4' }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.warn,
                         flex: '0 0 auto' }} />
          <span style={{ fontSize: 11, fontWeight: 700, color: '#8A5B0B' }}>
            Receiver held · no UE
          </span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: S.xs }}>
        <Hero label="SINR (ul)" unit="dB" value={k?.snr_db ?? null} tone="live"
          absent={sinrAbsent} />
        <Hero label="Applied loss" unit="dB" value={s?.applied_db != null ? -s.applied_db : null}
          tone={live?.params?.mode === 'static' || held ? 'warn' : 'live'}
          absent="channel not streaming" />
        <Hero label="Walked" unit="m" value={Math.round(walked)} dp={0} />
      </div>
    </div>
  )
}

function ColHead({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6,
                  paddingBottom: 4, borderBottom: '1px solid ' + T.bd }}>
      <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.6px',
                     textTransform: 'uppercase', color: T.dim }}>{children}</span>
      {live != null && (
        <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 800, letterSpacing: '.4px',
                       textTransform: 'uppercase', padding: '1px 6px', borderRadius: 999,
                       color: live ? '#327985' : T.dim,
                       background: live ? '#E6EFF0' : '#F1F5F6' }}>
          {live ? 'live' : 'idle'}
        </span>
      )}
    </div>
  )
}

function Hero({ label, unit, value, tone, dp = 1, absent }: {
  label: string; unit: string; value: number | null; tone?: 'live' | 'warn'; dp?: number
  absent?: string
}) {
  const colour = value == null ? T.dim : tone === 'warn' ? T.warn : tone === 'live' ? T.brand : T.ink
  return (
    <div>
      {value == null && absent ? (
        <div style={{ fontSize: 11.5, fontWeight: 700, color: T.dim, lineHeight: 1.25,
                      minHeight: 23, display: 'flex', alignItems: 'center' }}>
          {absent}
        </div>
      ) : (
        <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-.6px', color: colour,
                      lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
          {value == null ? '—' : value.toFixed(dp)}
          {value != null && <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 3 }}>{unit}</span>}
        </div>
      )}
      <div style={{ fontSize: 10, color: T.mut, fontWeight: 700, marginTop: 2 }}>{label}</div>
    </div>
  )
}

type Pt = { ago: number; v: number }

type Series = {
  name: string; unit: string; colour: string; points: Pt[]
  window: [number, number]
  mark?: { at: number; label: string }
}

function StackedSeries({ series, span }: { series: Series[]; span: number }) {
  const H = 30
  const scaleOf = (sr: Series): [number, number] => {
    const vs = sr.points.map((p) => p.v)
    if (!vs.length) return sr.window
    return [Math.min(sr.window[0], ...vs), Math.max(sr.window[1], ...vs)]
  }
  const yOf = (v: number, lo: number, hi: number) =>
    H - 3 - ((v - lo) / (hi - lo || 1)) * (H - 8)
  const path = (pts: Pt[], lo: number, hi: number) => {
    if (pts.length < 2) return ''
    return pts
      .map((p) => {
        const x = span > 0 ? 100 * (1 - p.ago / span) : 100
        return `${x.toFixed(2)},${yOf(p.v, lo, hi).toFixed(2)}`
      })
      .join(' ')
  }

  return (
    <div style={{ marginTop: S.sm }}>
      {series.map((sr) => {
        const [lo, hi] = scaleOf(sr)
        const vs = sr.points.map((p) => p.v)
        const seenLo = vs.length ? Math.min(...vs) : 0
        const seenHi = vs.length ? Math.max(...vs) : 0
        const markY = sr.mark && sr.mark.at >= lo && sr.mark.at <= hi
          ? yOf(sr.mark.at, lo, hi) : null
        return (
          <div key={sr.name} style={{ marginBottom: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                          fontSize: 10, fontWeight: 700, color: T.mut, marginBottom: 1 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 9, height: 2, background: sr.colour, borderRadius: 1 }} />
                {sr.name}
              </span>
              <span className="sk-mono" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {sr.points.length
                  ? `${seenLo.toFixed(1)}…${seenHi.toFixed(1)} ${sr.unit}`
                  : 'no samples'}
              </span>
            </div>
            <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none"
              style={{ width: '100%', height: 34, display: 'block', background: T.fill,
                       borderRadius: 6 }}>
              {markY != null && (
                <line x1="0" x2="100" y1={markY} y2={markY} stroke={T.mut} strokeWidth="1"
                  strokeDasharray="3 3" vectorEffect="non-scaling-stroke" opacity="0.7" />
              )}
              <polyline points={path(sr.points, lo, hi)} fill="none" stroke={sr.colour}
                strokeWidth="1.6" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
            </svg>
            {sr.mark && markY != null && (
              <div style={{ fontSize: 9.5, color: T.mut, fontWeight: 600, marginTop: 1 }}>
                - - {sr.mark.label}
              </div>
            )}
          </div>
        )
      })}
      <div style={{ fontSize: 10, color: T.mut, fontWeight: 600 }}>
        {Math.round(span)}s
      </div>
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden
      style={{ transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s', flex: '0 0 auto' }}>
      <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke={T.dim} strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
