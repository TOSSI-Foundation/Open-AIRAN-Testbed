import type { Collections } from './types'

const TONE = {
  ok: { fg: '#327985', bg: '#E6EFF0' },
  neutral: { fg: '#3B4C54', bg: '#EEF3F4' },
  warn: { fg: '#B07908', bg: '#FDF1DF' },
  danger: { fg: '#B3272C', bg: '#FDECEC' },
  idle: { fg: '#6D8E99', bg: '#F1F5F6' },
}

export const SPARK = {
  rising:
    '0,30 12,26 24,31 36,22 48,27 60,19 72,24 84,16 96,21 108,13 120,18 132,22 144,14 156,19 168,11 180,16 192,20 204,12 216,17 228,9 240,13',
  volatile:
    '0,22 12,27 24,19 36,25 48,17 60,23 72,14 84,20 96,26 108,18 120,12 132,19 144,23 156,15 168,21 180,11 192,17 204,22 216,14 228,18 240,10',
  falling:
    '0,14 12,19 24,12 36,21 48,16 60,25 72,18 84,27 96,20 108,29 120,22 132,17 144,26 156,19 168,28 180,21 192,30 204,23 216,18 228,26 240,20',
  choppy:
    '0,26 12,20 24,28 36,21 48,30 60,24 72,18 84,27 96,19 108,25 120,15 132,23 144,17 156,26 168,20 180,29 192,22 204,16 216,24 228,18 240,25',
  steady:
    '0,18 12,23 24,15 36,27 48,20 60,14 72,25 84,17 96,22 108,28 120,19 132,24 144,16 156,21 168,27 180,18 192,23 204,13 216,20 228,25 240,17',
  spiky:
    '0,24 12,17 24,22 36,14 48,26 60,18 72,29 84,21 96,15 108,24 120,27 132,19 144,12 156,23 168,16 180,25 192,18 204,28 216,21 228,14 240,19',
  stepped:
    '0,32 12,32 24,26 36,26 48,26 60,20 72,20 84,26 96,26 108,20 120,20 132,20 144,14 156,14 168,20 180,20 192,14 204,14 216,14 228,14 240,14',
}

export const SERIES = {
  throughput:
    '0,95 30,88 60,102 90,78 120,86 150,66 180,74 210,58 240,70 270,50 300,62 330,44 360,56 390,38 420,50 450,34 480,46 510,30 540,42 570,26 600,36',
  sinr:
    '0,60 30,72 60,52 90,80 120,58 150,90 180,64 210,96 240,70 270,102 300,76 330,88 360,62 390,94 420,68 450,100 480,74 510,86 540,60 570,92 600,66',
  ues:
    '0,110 30,96 60,116 90,88 120,104 150,82 180,98 210,74 240,92 270,68 300,86 330,62 360,80 390,58 420,76 450,52 480,70 510,48 540,66 570,44 600,60',
  searching:
    '0,138 30,136 60,140 90,134 120,137 150,132 180,136 210,130 240,134 270,129 300,133 330,128 360,132 390,127 420,131 450,126 480,130 510,125 540,129 570,124 600,128',
  bler:
    '0,40 30,58 60,34 90,66 120,44 150,74 180,50 210,82 240,56 270,88 300,62 330,70 360,46 390,78 420,54 450,86 480,60 510,72 540,48 570,80 600,58',
}

const UES_LIVE = [
  { id: 'UE-1001', state: 'Connected', stateColor: TONE.ok.fg, cell: 'CELL-07', sinr: '22.4', sinrColor: '#0E1820', tput: '856 / 124', latency: '18', speed: '45', slice: 'eMBB', loc: '40.7128° N, 74.0060° W' },
  { id: 'UE-1002', state: 'Connected', stateColor: TONE.ok.fg, cell: 'CELL-03', sinr: '19.1', sinrColor: '#0E1820', tput: '645 / 98', latency: '21', speed: '32', slice: 'eMBB', loc: '40.7135° N, 74.0055° W' },
  { id: 'UE-1003', state: 'Handover', stateColor: TONE.warn.fg, cell: 'CELL-12 → CELL-08', sinr: '11.2', sinrColor: '#B57608', tput: '256 / 45', latency: '35', speed: '60', slice: 'URLLC', loc: '40.7112° N, 74.0071° W' },
  { id: 'UE-1004', state: 'Searching', stateColor: '#8A9BA3', cell: '—', sinr: 'No signal yet', sinrColor: '#9AAAB1', tput: '— / —', latency: '—', speed: '18', slice: 'mMTC', loc: '40.7149° N, 74.0033° W' },
  { id: 'UE-1005', state: 'Connected', stateColor: TONE.ok.fg, cell: 'CELL-05', sinr: '24.8', sinrColor: '#0E1820', tput: '912 / 141', latency: '15', speed: '0', slice: 'eMBB', loc: '40.7161° N, 74.0018° W' },
  { id: 'UE-1006', state: 'Dropped', stateColor: TONE.danger.fg, cell: 'CELL-11', sinr: '2.1', sinrColor: '#B3272C', tput: '— / —', latency: '—', speed: '72', slice: 'URLLC', loc: '40.7098° N, 74.0102° W' },
]

const UES_HARBOUR = [
  { id: 'UE-2001', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-02', sinr: '23.6', sinrColor: '#0E1820', tput: '702 / 110', latency: '17', speed: '0', slice: 'eMBB', loc: '53.5461° N, 9.9661° E' },
  { id: 'UE-2002', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-04', sinr: '20.9', sinrColor: '#0E1820', tput: '588 / 92', latency: '22', speed: '28', slice: 'eMBB', loc: '53.5448° N, 9.9702° E' },
  { id: 'UE-2003', state: 'Dropped', stateColor: TONE.danger.fg, cell: 'CELL-06', sinr: '4.8', sinrColor: '#B3272C', tput: '— / —', latency: '—', speed: '41', slice: 'URLLC', loc: '53.5412° N, 9.9744° E' },
  { id: 'UE-2004', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-01', sinr: '26.1', sinrColor: '#0E1820', tput: '844 / 131', latency: '14', speed: '0', slice: 'mMTC', loc: '53.5489° N, 9.9618° E' },
]

const UES_CAMPUS = [
  { id: 'UE-3001', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-A2', sinr: '27.4', sinrColor: '#0E1820', tput: '388 / 61', latency: '12', speed: '5', slice: 'eMBB', loc: '48.2649° N, 11.6712° E' },
  { id: 'UE-3002', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-A1', sinr: '24.1', sinrColor: '#0E1820', tput: '301 / 48', latency: '16', speed: '4', slice: 'eMBB', loc: '48.2661° N, 11.6698° E' },
  { id: 'UE-3003', state: 'Detached', stateColor: '#6D8E99', cell: 'CELL-A4', sinr: '22.7', sinrColor: '#0E1820', tput: '265 / 39', latency: '19', speed: '0', slice: 'mMTC', loc: '48.2673° N, 11.6740° E' },
]

export const MOCK: Collections = {
  runs: [
    { id: 'RUN-2024-05-21-001', name: 'Smart City Downtown', ver: 'v4', scenario: 'Smart City Downtown · v4', state: 'Running', color: TONE.ok.fg, bg: TONE.ok.bg, started: '21 May, 10:30', duration: '00:28:47', ues: '1,256', cells: '12', sinr: '18.6 dB', tput: '856 Mbps', kTput: '856', kSinr: '18.6', kBler: '0.8', kUes: '1,256', kSearch: '4 searching', caption: '1,256 UEs · 4 searching', axis: ['10:30', '10:37', '10:44', '10:51', '10:58'], rows: UES_LIVE },
    { id: 'RUN-2024-05-21-002', name: 'Highway A9 Corridor', ver: 'v1', scenario: 'Highway A9 Corridor · v1', state: 'Starting', color: '#B07908', bg: TONE.warn.bg, started: '21 May, 11:04', duration: '00:00:12', ues: '0', cells: '9', sinr: '—', tput: '—' },
    { id: 'RUN-2024-05-20-014', name: 'Harbour Industrial Park', ver: 'v2', scenario: 'Harbour Industrial Park · v2', state: 'Completed', color: TONE.neutral.fg, bg: TONE.neutral.bg, started: '20 May, 16:12', duration: '01:04:02', ues: '480', cells: '6', sinr: '21.2 dB', tput: '612 Mbps', kTput: '612', kSinr: '21.2', kBler: '0.4', kUes: '480', kSearch: 'none at end', caption: '480 UEs · final states at 01:04:02', axis: ['16:12', '16:28', '16:44', '17:00', '17:16'], rows: UES_HARBOUR },
    { id: 'RUN-2024-05-20-009', name: 'Smart City Downtown', ver: 'v3', scenario: 'Smart City Downtown · v3', state: 'Failed', color: TONE.danger.fg, bg: TONE.danger.bg, started: '20 May, 09:41', duration: '00:00:41', ues: '—', cells: '12', sinr: '—', tput: '—' },
    { id: 'RUN-2024-05-19-006', name: 'University Campus', ver: 'v7', scenario: 'University Campus · v7', state: 'Completed', color: TONE.neutral.fg, bg: TONE.neutral.bg, started: '19 May, 14:05', duration: '00:32:18', ues: '96', cells: '4', sinr: '24.9 dB', tput: '318 Mbps', kTput: '318', kSinr: '24.9', kBler: '0.3', kUes: '96', kSearch: 'none at end', caption: '96 UEs · final states at 00:32:18', axis: ['14:05', '14:13', '14:21', '14:29', '14:37'], rows: UES_CAMPUS },
    { id: 'RUN-2024-05-19-002', name: 'Highway A9 Corridor', ver: 'v1', scenario: 'Highway A9 Corridor · v1', state: 'Queued', color: '#6D8E99', bg: TONE.idle.bg, started: '—', duration: '—', ues: '—', cells: '9', sinr: '—', tput: '—' },
  ],
  scenes: [
    { id: 'scene_abc', name: 'Smart City Downtown', source: 'OpenStreetMap', area: '2.4 km²', buildings: '3,412', updated: 'Updated 2 days ago', badge: 'Validated', badgeBg: TONE.ok.bg, badgeFg: '#327985', slot: 'scene-1' },
    { id: 'scene_hbr', name: 'Harbour Industrial Park', source: 'OpenStreetMap', area: '4.1 km²', buildings: '892', updated: 'Updated 5 days ago', badge: 'Validated', badgeBg: TONE.ok.bg, badgeFg: '#327985', slot: 'scene-2' },
    { id: 'scene_cmp', name: 'University Campus', source: 'Uploaded · campus.glb', area: '0.8 km²', buildings: '64', updated: 'Updated 1 week ago', badge: '3 warnings', badgeBg: TONE.warn.bg, badgeFg: '#A56C08', slot: 'scene-3' },
    { id: 'scene_stn', name: 'Central Station Concourse', source: 'Uploaded · station.ifc', area: '0.2 km²', buildings: '11', updated: 'Updated 2 weeks ago', badge: 'Validated', badgeBg: TONE.ok.bg, badgeFg: '#327985', slot: 'scene-4' },
    { id: 'scene_hwy', name: 'Highway A9 Corridor', source: 'OpenStreetMap', area: '11.6 km²', buildings: '318', updated: 'Updated 3 weeks ago', badge: 'Needs review', badgeBg: TONE.danger.bg, badgeFg: '#B3272C', slot: 'scene-5' },
  ],
  jobs: [
    { name: 'ppo-handover-v9', dataset: 'downtown-peak-hour · 4.2M frames', pct: '68%', w: '68%', eta: '~22 min left', state: 'Training', color: '#327985', bg: TONE.ok.bg, metric: 'reward 0.812' },
    { name: 'sched-transformer-v3', dataset: 'harbour-mixed · 1.8M frames', pct: '100%', w: '100%', eta: 'finished 40 min ago', state: 'Completed', color: TONE.neutral.fg, bg: TONE.neutral.bg, metric: 'reward 0.774' },
    { name: 'beam-select-v2', dataset: 'campus-indoor · 0.9M frames', pct: '12%', w: '12%', eta: 'queued for GPU', state: 'Queued', color: '#6D8E99', bg: TONE.idle.bg, metric: '—' },
  ],
  models: [
    { name: 'ppo-handover', ver: 'v8', task: 'Handover control', state: 'Live', color: TONE.ok.fg, bg: TONE.ok.bg, delta: '+6.4% vs baseline', deltaColor: '#327985', run: 'RUN-2024-05-21-001', created: '18 May 2024' },
    { name: 'ppo-handover', ver: 'v7', task: 'Handover control', state: 'Candidate', color: '#B07908', bg: TONE.warn.bg, delta: '+4.1% vs baseline', deltaColor: '#327985', run: 'RUN-2024-05-19-006', created: '11 May 2024' },
    { name: 'sched-transformer', ver: 'v2', task: 'MAC scheduling', state: 'Reverted', color: TONE.danger.fg, bg: TONE.danger.bg, delta: '−2.8% vs baseline', deltaColor: '#B3272C', run: 'RUN-2024-05-12-004', created: '5 May 2024' },
    { name: 'beam-select', ver: 'v1', task: 'Beam selection', state: 'Candidate', color: '#B07908', bg: TONE.warn.bg, delta: '+1.9% vs baseline', deltaColor: '#327985', run: 'RUN-2024-05-08-002', created: '28 Apr 2024' },
  ],
  reports: [
    { name: 'Smart City Downtown — coverage & KPI summary', run: 'RUN-2024-05-21-001', kind: 'PDF', size: '4.2 MB', by: 'John Doe', when: '21 May, 11:12', state: 'Ready', color: '#327985', bg: TONE.ok.bg },
    { name: 'AI vs baseline handover benchmark', run: 'RUN-2024-05-19-006', kind: 'HTML', size: '1.1 MB', by: 'Priya Raman', when: '19 May, 15:48', state: 'Ready', color: '#327985', bg: TONE.ok.bg },
    { name: 'Harbour Industrial Park — full run export', run: 'RUN-2024-05-20-014', kind: 'PDF', size: '—', by: 'John Doe', when: '20 May, 17:20', state: 'Generating', color: '#B07908', bg: TONE.warn.bg },
    { name: 'Weekly tenant usage digest', run: 'All runs', kind: 'PDF', size: '0.6 MB', by: 'Automated', when: '19 May, 06:00', state: 'Ready', color: '#327985', bg: TONE.ok.bg },
  ],
  alerts: [
    { sev: 'Critical', color: TONE.danger.fg, bg: TONE.danger.bg, title: 'Cell cell_11 has no attached UEs for 5 min', rule: 'cell.attached_ues == 0 for 5m', entity: 'cell_11 · RUN-2024-05-21-001', when: '4 min ago', ack: 'Acknowledge' },
    { sev: 'Critical', color: TONE.danger.fg, bg: TONE.danger.bg, title: 'BLER above 5% on slice URLLC', rule: 'slice.bler_pct > 5 for 2m', entity: 'slice URLLC · RUN-2024-05-21-001', when: '12 min ago', ack: 'Acknowledge' },
    { sev: 'Warning', color: '#B07908', bg: TONE.warn.bg, title: 'UE-1003 handover ping-pong detected', rule: 'ue.handovers > 4 in 60s', entity: 'UE-1003 · CELL-12 ⇄ CELL-08', when: '26 min ago', ack: 'Acknowledge' },
    { sev: 'Warning', color: '#B07908', bg: TONE.warn.bg, title: 'GPU quota at 82% for TOSSI', rule: 'tenant.gpu_hours > 80%', entity: 'Tenant · TOSSI', when: '1 hr ago', ack: 'Acknowledge' },
    { sev: 'Resolved', color: '#5B6E77', bg: TONE.neutral.bg, title: 'DU restart completed on du-01', rule: 'component.health != up', entity: 'du-01 · RUN-2024-05-20-009', when: 'Yesterday', ack: 'View' },
  ],
  users: [
    { name: 'John Doe', email: 'john@tossi.org', role: 'Admin', color: '#327985', bg: TONE.ok.bg, team: 'Network planning', last: 'Active now', runs: '48' },
    { name: 'Priya Raman', email: 'priya@tossi.org', role: 'Editor', color: '#6093BA', bg: '#ECF2F7', team: 'RAN research', last: '2 hrs ago', runs: '112' },
    { name: 'Marc Olsen', email: 'marc@tossi.org', role: 'Editor', color: '#6093BA', bg: '#ECF2F7', team: 'AI / ML', last: 'Yesterday', runs: '74' },
    { name: 'Sara Vogel', email: 'sara@tossi.org', role: 'Viewer', color: '#5B6E77', bg: TONE.neutral.bg, team: 'Stakeholders', last: '3 days ago', runs: '0' },
    { name: 'ci-bot', email: 'ci@tossi.org', role: 'Service', color: '#6D8E99', bg: TONE.idle.bg, team: 'Automation', last: 'Active now', runs: '306' },
  ],
  quotas: [
    { label: 'Concurrent runs', used: '3 of 8', w: '38%', c: '#327985' },
    { label: 'GPU hours this month', used: '410 of 500', w: '82%', c: '#D97706' },
    { label: 'Scene storage', used: '124 GB of 500 GB', w: '25%', c: '#327985' },
    { label: 'Seats', used: '5 of 10', w: '50%', c: '#327985' },
  ],
}
