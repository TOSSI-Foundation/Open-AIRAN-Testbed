import { authHeader } from './auth'

const BASE = '/api/map'

export interface MapHealth {
  available: boolean
  python: string
  module: string
  scene_builder: string
  work_dir: string
  live_channel: string | null
  live_available: boolean
  models_dir: string
  du_config_dirs: string[]
  nof_du_configs: number
  max_taps: number
  max_model_mb: number
  queue_depth: number
}

export interface DuConfig {
  path: string
  name: string
  srate_hz: number | null
  bw_mhz: number | null
  dl_arfcn: number | null
  dl_freq_hz: number | null
  live_bind: string | null
  sionna_driver: boolean
  readable: boolean
}

export interface ModelFile {
  name: string
  size: number
  uploaded: number
}

export interface SceneMeta {
  scene_id: string
  name?: string | null
  built: boolean
  has_coverage: boolean
  has_package: boolean
  state?: string
  city?: string | null
  created?: number
  built_at?: number
  nof_buildings?: number
  nof_gnb?: number
  nof_ue?: number
  nof_edits?: number
  nof_meshes?: number
  buildings_extruded?: number
  buildings_skipped?: number
  size_m?: [number, number] | null
  origin_lonlat?: [number, number] | null
  coverage_stats?: CoverageStats
  trace?: TraceResult
}

export interface SceneSeal {
  ok: boolean
  sealed: boolean
  matches: boolean | null
  changed?: string[]
  sealed_at_iso?: string
  fingerprint?: { geometry_short?: string; nof_meshes?: number }
  sealed_fingerprint?: { geometry_short?: string }
  error?: string
}

export interface ChannelExport {
  name: string
  bytes: number
  created: number
  kind: string
  download: string

  direction?: string
  paths?: string
  paths_bytes?: number

  link_gain_db?: Record<string, number>
  link_paths?: Record<string, number>
  city?: string
  nof_meshes?: number
}

export interface CoverageBand {
  threshold_db: number
  unit: string
  cells_total: number
  cells_served: number
  cells_above: number
  fraction_of_served: number
  fraction_of_area: number
}

export interface CoverageStats {
  covered_cells: number
  total_cells: number
  gain_db_min: number | null
  gain_db_max: number | null
  cells_reached?: number
  coverage?: Record<string, CoverageBand>
}

export interface CoverageOverlay {
  type: string
  image: string
  coordinates: [number, number][]
  vmin: number
  vmax: number
  stats: CoverageStats
}

export interface TapsInfo {
  taps: number
  wanted: number
  clamped: boolean
  cap: number
  span_m: number
  scene_diag_m: number
}

export interface RayPath {
  points?: number[][]
  kinds?: string[]
  bounces?: number
  los?: boolean
  gain_db?: number
  share?: number
  delay_s?: number
}

export interface TraceLink {
  ue: string
  position: number[]
  paths: number
  gain_db: number
  best_tx?: string
  best_gain_db?: number
  path_detail?: RayPath[]
}

export interface TraceMatrixEntry {
  ue: string
  tx: string
  paths: number
  gain_db: number
  best: boolean
}

export interface TraceResult {
  ok: boolean
  scene: string
  carrier_hz: number
  band: number | string
  array: { rows: number; cols: number; pattern: string; pol: string; nof_tx_ant: number }
  tx_power_dbm: number
  srate_hz: number
  max_depth?: number
  taps: TapsInfo
  transmitters?: { name: string; position: number[]; serving: boolean }[]
  serving_tx: { name: string; index?: number; position: number[]; azimuth_deg: number; downtilt_deg: number }
  links: TraceLink[]
  matrix?: TraceMatrixEntry[]
  live_command: string
}

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

export interface Job {
  job_id: string
  kind: 'build' | 'trace' | 'coverage'
  scene_id: string | null
  label: string
  state: JobState
  pct: number
  message: string
  error: string | null
  result: any
  elapsed_s: number
  log?: string[]
}

export interface LiveSample {
  t: number
  seq: number
  gain_db?: number
  applied_db?: number
  attenuation_db?: number
  paths?: number
  trace_ms?: number
  pos?: [number, number]
}

export interface LiveStatus {
  running: boolean
  scene_id: string | null
  params: Record<string, any>
  uptime_s: number
  updates: number
  last: LiveSample | Record<string, never>
  samples: LiveSample[]
  log: string[]
  exit_code: number | null
  moving?: boolean
}

export interface ApiError {
  ok: false
  error: string
  status?: number
}

export type Result<T> = T | ApiError

export function isError<T>(r: Result<T>): r is ApiError {
  return !!r && typeof r === 'object' && (r as ApiError).ok === false && 'error' in r
}

async function req<T>(path: string, init?: RequestInit): Promise<Result<T>> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...authHeader(), ...(init?.headers as Record<string, string>) },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    if (!res.ok) {
      return { ok: false, error: body?.error ?? `HTTP ${res.status}`, status: res.status }
    }
    return body as T
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  }
}

async function reqAbs<T>(path: string, init?: RequestInit): Promise<T | ApiError> {
  try {
    const res = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...authHeader(), ...((init?.headers as Record<string, string>) ?? {}) },
    })
    const text = await res.text()
    const body = text ? JSON.parse(text) : {}
    if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}`, status: res.status }
    return body as T
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'network error' }
  }
}

const get = <T,>(p: string) => req<T>(p)
const post = <T,>(p: string, body?: unknown) =>
  req<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) })

export interface BuildOptions {
  min_area?: number
  ground_material?: string
  terrain?: boolean
  fetch_overture?: boolean
  vegetation?: boolean
}

export interface TraceOptions {
  srate?: number
  max_depth?: number
  tx?: string
  du_config?: string
  route_step_m?: number
}

export interface RouteTrace {
  route: { ue: string; step_m: number; length_m: number; points: number[][]; s_m: number[] }
  matrix: { ue: string; tx: string; gain_db: number; paths: number; best: boolean; los: boolean;
            path_detail?: Record<string, unknown>[] }[]
}

export interface CoverageOptions {
  samples?: number
  cell_size?: number
  max_depth?: number
  vmin?: number
  vmax?: number
}

export interface LiveOptions {
  mode?: 'static' | 'route' | 'sweep'
  bind?: string
  interval?: number
  steps?: number
  srate?: number
  num_taps?: number
  max_depth?: number
  loop_route?: boolean
  max_drop_db?: number
  du_config?: string
  tx?: string
}

export const GROUND_MATERIALS = [
  'very_dry_ground', 'medium_dry_ground', 'wet_ground', 'concrete', 'marble',
] as const

export const GROUND_MATERIAL_LABELS = [
  'Very dry ground', 'Medium dry ground', 'Wet ground', 'Concrete', 'Marble',
]

export const mapApi = {
  health: () => get<MapHealth>('/health'),

  scenes: () => get<SceneMeta[]>('/scenes'),
  scene: (id: string) => get<SceneMeta>(`/scenes/${id}`),
  scenePackage: (id: string) => get<any>(`/scenes/${id}/package`),
  routeTrace: (id: string) => get<RouteTrace>(`/scenes/${id}/route-trace`),
  sceneCoverage: (id: string) =>
    get<{ ok: boolean; scene_id: string; overlay: CoverageOverlay }>(`/scenes/${id}/coverage`),
  deleteScene: (id: string) => req<{ ok: boolean }>(`/scenes/${id}`, { method: 'DELETE' }),
  sceneSnapshot: (id: string, image: string) =>
    req<{ ok: boolean; bytes: number }>(`/scenes/${id}/snapshot`, {
      method: 'POST',
      body: JSON.stringify({ image }),
    }),

  build: (pkg: unknown, opts: BuildOptions = {}) =>
    post<{ ok: boolean; job_id: string; scene_id: string }>('/build', { package: pkg, ...opts }),
  trace: (scene_id: string, opts: TraceOptions = {}) =>
    post<{ ok: boolean; job_id: string }>('/trace', { scene_id, ...opts }),
  channelExports: (id: string) =>
    reqAbs<{ ok: boolean; scene_id: string; exports: ChannelExport[] }>(
      `/api/channel/scenes/${id}/exports`),
  linkKpi: (id: string, body: Record<string, unknown> = {}) =>
    reqAbs<{ ok: boolean; kpis?: unknown[]; result?: { kpis?: unknown[] }; error?: string }>(
      `/api/channel/scenes/${id}/linkkpi`,
      { method: 'POST', body: JSON.stringify({ ...body, wait: true }) }),

  channelExport: (id: string) =>
    reqAbs<{ ok: boolean; job_id?: string; state?: string; error?: string }>(
      `/api/channel/scenes/${id}/export`, { method: 'POST', body: '{}' }),

  sceneBundle: (id: string) =>
    reqAbs<{ ok: boolean; job_id?: string; result?: { name?: string }; error?: string }>(
      `/api/channel/scenes/${id}/bundle`,
      { method: 'POST', body: JSON.stringify({ wait: true }) }),

  sceneSeal: (id: string) =>
    reqAbs<SceneSeal>(`/api/provenance/scenes/${id}?check_only=1`),

  sealScene: (id: string) =>
    reqAbs<{ ok: boolean; error?: string }>(
      `/api/provenance/scenes/${id}/seal`, { method: 'POST', body: '{}' }),

  coverage: (scene_id: string, opts: CoverageOptions = {}) =>
    post<{ ok: boolean; job_id: string }>('/coverage', { scene_id, ...opts }),

  job: (id: string) => get<Job>(`/jobs/${id}`),
  jobs: () => get<Job[]>('/jobs'),
  cancelJob: (id: string) => post<{ ok: boolean; cancelled: boolean }>(`/jobs/${id}/cancel`),

  sceneConfig: (id: string) =>
    get<{ ok?: boolean; name?: string; du_config?: string }>(`/scenes/${id}/config`),
  setSceneConfig: (id: string, body: Record<string, unknown>) =>
    post<{ ok: boolean; error?: string }>(`/scenes/${id}/config`, body),

  sceneSionna: (id: string) =>
    get<{ ok?: boolean; params?: Record<string, unknown> }>(`/scenes/${id}/sionna`),
  setSceneSionna: (id: string, patch: Record<string, unknown>) =>
    post<{ ok?: boolean; params?: Record<string, unknown>; error?: string }>(`/scenes/${id}/sionna`, patch),

  sceneUe: (id: string) =>
    get<{ ok?: boolean; params?: Record<string, unknown>; effective?: Record<string, unknown> }>(`/scenes/${id}/ue`),
  setSceneUe: (id: string, patch: Record<string, unknown>) =>
    post<{ ok?: boolean; params?: Record<string, unknown>; effective?: Record<string, unknown>; error?: string }>(`/scenes/${id}/ue`, patch),

  setSceneGnbConfig: (id: string, body: Record<string, unknown> = {}) =>
    post<{ ok: boolean; error?: string; path?: string }>(`/scenes/${id}/gnb-config`, body),

  duConfigText: (path: string) =>
    get<{ ok: boolean; text?: string; error?: string }>(
      `/du-configs/text?path=${encodeURIComponent(path)}`),
  saveDuConfigText: (path: string, text: string) =>
    post<{ ok: boolean; error?: string; name?: string }>('/du-configs/text', { path, text }),

  deleteChannelExport: (name: string) =>
    reqAbs<{ ok: boolean; error?: string }>(
      `/api/channel/exports/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  duConfigs: () => get<DuConfig[]>('/du-configs'),

  models: () => get<ModelFile[]>('/models'),
  uploadModel: async (file: File): Promise<Result<{ ok: boolean; name: string }>> => {
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${BASE}/models`, { method: 'POST', body: fd, headers: { ...authHeader() } })
      const body = await res.json()
      if (!res.ok) return { ok: false, error: body?.error ?? `HTTP ${res.status}`, status: res.status }
      return body
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'upload failed' }
    }
  },
  deleteModel: (name: string) => req<{ ok: boolean }>(`/models/${name}`, { method: 'DELETE' }),

  liveStart: (scene_id: string, opts: LiveOptions = {}) =>
    post<{ ok: boolean; scene_id: string; params: Record<string, any>; warnings: string[]; command: string }>(
      '/live/start', { owner: 'raytrace', scene_id, ...opts }),
  liveStatus: () => get<LiveStatus>('/live/status'),
  liveStop: () => post<{ ok: boolean; stopped: boolean }>('/live/stop', { owner: 'raytrace' }),
}

export async function pollJob(
  jobId: string,
  onUpdate: (j: Job) => void,
  opts: { intervalMs?: number; signal?: AbortSignal } = {},
): Promise<Job | ApiError> {
  const interval = opts.intervalMs ?? 600
  for (;;) {
    if (opts.signal?.aborted) return { ok: false, error: 'cancelled' }
    const j = await mapApi.job(jobId)
    if (isError(j)) return j
    onUpdate(j)
    if (j.state === 'done' || j.state === 'failed' || j.state === 'cancelled') return j
    await new Promise((r) => setTimeout(r, interval))
  }
}

export function fmtDb(v: number | null | undefined, digits = 1): string {
  return v == null || !isFinite(v) ? '—' : `${v.toFixed(digits)} dB`
}

export function fmtWhen(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const now = Date.now() / 1000
  const age = now - ts
  if (age < 60) return 'just now'
  if (age < 3600) return `${Math.floor(age / 60)} min ago`
  if (age < 86400) return `${Math.floor(age / 3600)} hr ago`
  return d.toLocaleDateString()
}
