export type RouteKey =
  | 'home'
  | 'deployments'
  | 'topology'
  | 'agents'
  | 'servers'
  | 'scenes'
  | 'builder'
  | 'simulation'
  | 'runs'
  | 'run'
  | 'replay'
  | 'lake'
  | 'studio'
  | 'reports'
  | 'alerts'
  | 'admin'

export type ToneKey = 'ok' | 'neutral' | 'warn' | 'danger' | 'idle'

export type RunState =
  | 'Running'
  | 'Starting'
  | 'Completed'
  | 'Failed'
  | 'Queued'

export interface UeRow {
  id: string
  state: string
  stateColor: string
  cell: string
  sinr: string
  sinrColor: string
  tput: string
  latency: string
  speed: string
  slice: string
  loc: string
}

export interface Run {
  id: string
  name?: string
  ver?: string
  scenario?: string
  state: string
  color: string
  bg: string
  started: string
  duration?: string
  ues?: string
  cells?: string
  sinr?: string
  tput?: string
  kTput?: string
  kSinr?: string
  kBler?: string
  kUes?: string
  kSearch?: string
  caption?: string
  axis?: string[]
  rows?: UeRow[]
  scene?: string
  city?: string
  area?: string
  coverage_pct?: number | null
  gain_db_min?: number | null
  gain_db_max?: number | null
  has_coverage?: boolean
  built?: boolean
  overlay_url?: string | null
  thumb?: string | null
}

export interface Scene {
  id: string
  name: string
  source: string
  area: string
  buildings: string
  updated: string
  badge: string
  badgeBg: string
  badgeFg: string
  slot: string
  built?: boolean
  city?: string
  coverage?: boolean
  bbox?: { size_m?: [number, number]; [k: string]: unknown }
  nodes?: { gnb: number; ue: number }
}

export interface Job {
  name: string
  dataset: string
  pct: string
  w: string
  eta: string
  state: string
  color: string
  bg: string
  metric: string
}

export interface Model {
  name: string
  ver: string
  task: string
  state: string
  color: string
  bg: string
  delta: string
  deltaColor: string
  run: string
  created: string
}

export interface Report {
  name: string
  run: string
  kind: string
  size: string
  by: string
  when: string
  state: string
  color: string
  bg: string
}

export interface Alert {
  sev: string
  color: string
  bg: string
  title: string
  rule: string
  entity: string
  when: string
  ack: string
}

export interface User {
  name: string
  email: string
  role: string
  color: string
  bg: string
  team: string
  last: string
  runs: string
}

export interface Quota {
  label: string
  used: string
  w: string
  c: string
}

export interface Collections {
  runs: Run[]
  scenes: Scene[]
  jobs: Job[]
  models: Model[]
  reports: Report[]
  alerts: Alert[]
  users: User[]
  quotas: Quota[]
}

export interface KpiEvent {
  run_id: string
  t_ns: number
  entity: 'cell' | 'ue' | 'link' | 'slice' | 'system'
  entity_id: string
  metric: string
  value: number
}
