import { UserChip } from '../components/TopBar'
import { useParams, useNavigate } from 'react-router-dom'
import { MetricChart } from '../components/MetricChart'
import { UeTable } from '../components/UeTable'
import { StatusPill, SegTabs } from '../components/ui'
import { Icon } from '../components/Icon'
import { useCollection } from '../lib/useData'
import { SERIES } from '../lib/mockData'
import { useState } from 'react'
import { CoverageRunDetail } from './CoverageRunDetail'
import type { Run } from '../lib/types'

const TABS = ['Dashboards', 'Live 3D', 'UEs', 'Logs', 'Timeline']

export function ScreenRunDetail() {
  const { id } = useParams()
  const nav = useNavigate()
  const runs = useCollection('runs') as Run[]
  const run = runs.find((r) => r.id === id) ?? runs[0]
  const [tab, setTab] = useState('Dashboards')

  const isCoverageRun = run.city !== undefined || run.coverage_pct !== undefined || run.has_coverage !== undefined
  if (isCoverageRun) {
    return <CoverageRunDetail run={run} />
  }

  const live = run.state === 'Running' || run.state === 'Completed'
  const failed = run.state === 'Failed'
  const notStarted = run.state === 'Queued' || run.state === 'Starting'

  return (
    <div style={{ padding: '18px 34px 34px', color: '#0E1820' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <a onClick={() => nav('/runs')} style={{ cursor: 'pointer' }}>Runs</a>
            <Icon.chevronRight size={14} stroke="#A3B2B8" />
            <span className="sk-mono" style={{ fontSize: 15, fontWeight: 700 }}>{run.id}</span>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.7px', marginTop: 8 }}>{run.name}</div>
          <div style={{ fontSize: 14, color: '#5B6E77', marginTop: 4, fontWeight: 500 }}>{run.scenario} · started {run.started}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusPill label={run.state} fg={run.color} bg={run.bg} />
          {run.state === 'Running' ? (
            <button className="sk-btn-ghost" style={{ color: '#B3272C', borderColor: '#F0CFD0' }}>Stop run</button>
          ) : (
            <button className="sk-btn-ghost">Duplicate</button>
          )}
          <UserChip />
        </div>
      </div>

      <StageStepper failed={failed} ueLabel={run.ues ?? '—'} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 22, borderBottom: '1px solid #E2E9EA' }}>
        {TABS.map((t) => {
          const on = t === tab
          return (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: 'transparent',
                border: 'none',
                padding: '11px 4px',
                margin: '0 14px 0 0',
                fontSize: 14.5,
                fontWeight: 700,
                cursor: 'pointer',
                color: on ? '#327985' : '#6D8E99',
                borderBottom: on ? '2px solid #327985' : '2px solid transparent',
                fontFamily: 'inherit',
              }}
            >
              {t}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: 22 }}>
        {failed && <FailedBody run={run} />}
        {notStarted && <NotStartedBody run={run} />}
        {live && tab === 'Dashboards' && <Dashboards run={run} />}
        {live && tab === 'UEs' && (
          <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ padding: '16px 22px', fontSize: 16, fontWeight: 800 }}>{run.caption ?? 'UEs'}</div>
            <UeTable rows={run.rows ?? []} />
          </div>
        )}
        {live && tab === 'Live 3D' && <PlaceholderPanel title="Live 3D digital twin" note="Buildings, cells and UEs stream from the KPI bus (M8) into a glTF viewport (M4/M5)." />}
        {live && tab === 'Logs' && <LogsPanel />}
        {live && tab === 'Timeline' && <PlaceholderPanel title="Timeline / Replay" note="Once the run ends, the timeline scrubber (M10) lets you replay positions and KPIs together." />}
      </div>
    </div>
  )
}

function StageStepper({ failed, ueLabel }: { failed: boolean; ueLabel: string }) {
  const stages = [
    { label: 'Core', ok: true, sub: 'Healthy' },
    { label: 'CU', ok: true, sub: 'Healthy' },
    { label: 'DU', ok: !failed, sub: failed ? 'Failed' : 'Healthy' },
    { label: 'Radio', ok: !failed, sub: failed ? '—' : 'Healthy' },
    { label: 'UEs', ok: !failed, sub: failed ? '—' : ueLabel },
    { label: 'Traffic', ok: !failed, sub: failed ? '—' : 'Active' },
  ]
  return (
    <div style={{ position: 'relative', marginTop: 22, background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '24px 40px' }}>
      <div style={{ position: 'absolute', top: 40, left: 64, right: 64, height: 2, background: '#D9EAE3' }} />
      <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between' }}>
        {stages.map((s) => (
          <div key={s.label} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, width: 70 }}>
            <span style={{ width: 32, height: 32, borderRadius: '50%', background: s.ok ? '#327985' : '#B3272C', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {s.ok ? (
                <Icon.check size={16} stroke="#fff" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4"><path d="M12 7v6M12 16.4v.1" /></svg>
              )}
            </span>
            <span style={{ fontSize: 12, fontWeight: 700 }}>{s.label}</span>
            <span style={{ fontSize: 11.5, fontWeight: 700, marginTop: -4, color: s.ok ? '#327985' : '#B3272C' }}>{s.sub}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Dashboards({ run }: { run: any }) {
  const axis = run.axis ?? ['', '', '', '', '']
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontSize: 12.5, color: '#6D8E99', fontWeight: 700 }}>{run.caption}</div>
        <SegTabs options={['Live', '1H', '6H', '24H']} active={run.state === 'Running' ? 'Live' : '1H'} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        <MetricChart title="Throughput" subtitle="Downlink aggregate · Mbps" value={run.kTput ?? '—'} delta="↗ 5.7% last 5 min" deltaColor="#327985" color="#327985" points={SERIES.throughput} yLabels={['1000', '750', '500', '250', '0']} axis={axis} />
        <MetricChart title="SINR" subtitle="Mean across connected UEs · dB" value={run.kSinr ?? '—'} delta="↗ 3.1% last 5 min" deltaColor="#327985" color="#6093BA" points={SERIES.sinr} yLabels={['30', '22', '15', '7', '0']} axis={axis} />
        <MetricChart title="Connected UEs" subtitle="Attached & registered" value={run.kUes ?? '—'} delta={run.kSearch ?? ''} deltaColor="#6D8E99" color="#327985" points={SERIES.ues} secondaryPoints={SERIES.searching} yLabels={['1500', '1125', '750', '375', '0']} axis={axis} />
        <MetricChart title="BLER" subtitle="Block error rate · %" value={run.kBler ?? '—'} delta="↘ 6.1% last 5 min" deltaColor="#327985" color="#D86993" points={SERIES.bler} yLabels={['5', '3.8', '2.5', '1.2', '0']} axis={axis} />
      </div>
    </div>
  )
}

function FailedBody({ run }: { run: any }) {
  return (
    <div style={{ background: '#FEF2F2', border: '1px solid #F6D4D5', borderRadius: 16, padding: '22px 24px', display: 'flex', gap: 14 }}>
      <Icon.info size={22} stroke="#D13B40" width={1.9} style={{ flex: '0 0 22px', marginTop: 2 }} />
      <div>
        <div style={{ fontSize: 17, fontWeight: 800, color: '#B3272C' }}>Run failed at stage “DU”</div>
        <div style={{ fontSize: 14, color: '#8E4245', marginTop: 6, lineHeight: 1.55, maxWidth: 640 }}>
          du-01 exited with code 137 (out of memory) {run.duration} into the run. Partial KPIs up to {run.duration} are available.
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <span style={{ background: '#B3272C', color: '#fff', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>View logs</span>
          <span style={{ background: '#fff', border: '1px solid #F0CFD0', color: '#B3272C', borderRadius: 9, padding: '9px 15px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>Retry run</span>
        </div>
      </div>
    </div>
  )
}

function NotStartedBody({ run }: { run: any }) {
  const starting = run.state === 'Starting'
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '48px 40px', display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: 64, height: 64, borderRadius: 18, background: starting ? '#FDF1DF' : '#F1F5F6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {starting ? (
          <Icon.spinner size={30} stroke="#B07908" style={{ animation: 'spin 1.4s linear infinite' }} />
        ) : (
          <Icon.play size={28} stroke="#6D8E99" />
        )}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, marginTop: 18 }}>
        {starting ? 'Bringing the run up…' : 'Run is queued'}
      </div>
      <div style={{ fontSize: 15, color: '#5B6E77', marginTop: 8, maxWidth: 460, lineHeight: 1.55 }}>
        {starting
          ? 'The core, CU and DU are starting in order. Live dashboards appear once the DU is healthy and UEs begin attaching.'
          : 'This run is waiting for a free slot. It will start automatically when capacity is available.'}
      </div>
    </div>
  )
}

function LogsPanel() {
  const lines = [
    ['10:30:02', 'core', 'AMF NGAP association established (192.168.70.132:38412)'],
    ['10:30:04', 'cu', 'F1 Setup: procedure completed successfully'],
    ['10:30:05', 'du', 'RF: Sionna live channel subscribed to tcp://127.0.0.1:5566'],
    ['10:30:06', 'du', 'Cell PCI 7 configured · 40 MHz · 30 kHz SCS · N_RB 106'],
    ['10:30:11', 'ue', 'UE-1001 sync → SIB1 → RA ok → RRC done → REGISTERED'],
    ['10:31:44', 'ue', 'UE-1003 handover CELL-12 → CELL-08 (A3 event)'],
  ]
  return (
    <div style={{ background: '#0E1820', borderRadius: 16, padding: '18px 22px', fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#C7D4D9', lineHeight: 1.9 }}>
      {lines.map((l, i) => (
        <div key={i} style={{ display: 'flex', gap: 14 }}>
          <span style={{ color: '#6B8089' }}>{l[0]}</span>
          <span style={{ color: '#4FBF7B', width: 44 }}>{l[1]}</span>
          <span>{l[2]}</span>
        </div>
      ))}
    </div>
  )
}

function PlaceholderPanel({ title, note }: { title: string; note: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '48px 40px', textAlign: 'center' }}>
      <div style={{ fontSize: 20, fontWeight: 800 }}>{title}</div>
      <div style={{ fontSize: 14.5, color: '#5B6E77', marginTop: 8, maxWidth: 520, marginInline: 'auto', lineHeight: 1.55 }}>{note}</div>
    </div>
  )
}
