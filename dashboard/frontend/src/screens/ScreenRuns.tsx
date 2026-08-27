import { useNavigate } from 'react-router-dom'
import { useState } from 'react'
import { PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'
import { useCollection } from '../lib/useData'
import type { Run } from '../lib/types'

const FILTERS = ['All', 'Completed', 'Scene built', 'Package only']

export function ScreenRuns() {
  const nav = useNavigate()
  const runs = useCollection('runs') as Run[]
  const [filter, setFilter] = useState('All')

  const isReal = runs.some((r) => r.city !== undefined || r.coverage_pct !== undefined)

  const shown = runs.filter((r) => filter === 'All' || r.state === filter)

  const counts = {
    All: runs.length,
    Completed: runs.filter((r) => r.state === 'Completed').length,
    'Scene built': runs.filter((r) => r.state === 'Scene built').length,
    'Package only': runs.filter((r) => r.state === 'Package only').length,
  }

  return (
    <div style={{ padding: '18px 34px 34px', color: '#0E1820' }}>
      <PageHeader
        title="Runs"
        actions={
          <button className="sk-btn-primary" onClick={() => nav('/builder')}>
            <Icon.plus size={16} stroke="#fff" />
            New run
          </button>
        }
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginTop: 22 }}>
        <SummaryTile label="Total runs" value={String(counts.All)} accent="#327985" />
        <SummaryTile label="Completed" value={String(counts.Completed)} accent="#0FA36B" />
        <SummaryTile label="Scene built" value={String(counts['Scene built'])} accent="#3B4C54" />
        <SummaryTile label="Package only" value={String(counts['Package only'])} accent="#B07908" />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {FILTERS.map((f) => {
          const on = f === filter
          return (
            <span
              key={f}
              onClick={() => setFilter(f)}
              style={{
                background: on ? '#327985' : '#fff',
                color: on ? '#fff' : '#3B4C54',
                border: on ? 'none' : '1px solid #E2E9EA',
                borderRadius: 999,
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {f} · {counts[f as keyof typeof counts]}
            </span>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 20, marginTop: 20 }}>
        {shown.map((r) => (
          <RunCard key={r.id} run={r} onOpen={() => nav(`/run/${r.id}`)} />
        ))}
      </div>
    </div>
  )
}

function SummaryTile({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '16px 20px' }}>
      <div style={{ fontSize: 12.5, color: '#5C6E76', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6, color: accent }}>{value}</div>
    </div>
  )
}

function RunCard({ run, onOpen }: { run: Run; onOpen: () => void }) {
  const scene = run.scene ?? run.name ?? run.scenario ?? 'Scene'
  const cov = run.coverage_pct
  const hasCov = run.has_coverage && cov != null

  return (
    <div
      onClick={onOpen}
      className="sk-runcard"
      style={{
        background: '#fff',
        border: '1px solid #E2E9EA',
        borderRadius: 16,
        overflow: 'hidden',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        transition: 'box-shadow .16s ease, transform .16s ease, border-color .16s ease',
      }}
    >
      <div
        style={{
          height: 116,
          background: run.thumb ? '#0E1820' : 'linear-gradient(135deg,#DBE8EA,#EEF4F5 60%,#E2ECEE)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderBottom: '1px solid #EDF2F3',
          position: 'relative',
        }}
      >
        {run.thumb ? (
          <img
            src={run.thumb}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', imageRendering: 'pixelated', opacity: 0.95 }}
          />
        ) : (
          <span style={{ fontSize: 12.5, color: '#7C9099', fontWeight: 600 }}>
            {run.built ? 'No coverage yet' : 'Not built'}
          </span>
        )}
        {run.thumb && (
          <span
            style={{
              position: 'absolute',
              bottom: 8,
              right: 10,
              fontSize: 10.5,
              fontWeight: 700,
              color: '#fff',
              background: 'rgba(14,26,32,.6)',
              borderRadius: 6,
              padding: '2px 7px',
            }}
          >
            coverage
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 18px 12px' }}>
        <span style={{ width: 4, alignSelf: 'stretch', borderRadius: 3, background: run.color }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: '-.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {scene}
          </div>
          <div className="sk-mono" style={{ fontSize: 11.5, color: '#8A9BA3', marginTop: 3, fontWeight: 600 }}>
            {run.id}
          </div>
        </div>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            borderRadius: 999,
            padding: '5px 11px',
            fontSize: 11.5,
            fontWeight: 800,
            background: run.bg,
            color: run.color,
            whiteSpace: 'nowrap',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: run.color }} />
          {run.state}
        </span>
      </div>

      <div style={{ padding: '0 18px 14px' }}>
        {hasCov ? (
          <>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, color: '#6D8E99', fontWeight: 600 }}>Coverage</span>
              <span style={{ fontSize: 20, fontWeight: 800, color: '#327985' }}>{cov}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 5, background: '#EEF3F4', overflow: 'hidden' }}>
              <div
                style={{
                  width: `${Math.min(100, cov!)}%`,
                  height: '100%',
                  background: 'linear-gradient(90deg,#327985,#6093BA)',
                }}
              />
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: '#9AAAB1', fontWeight: 600, padding: '6px 0' }}>
            {run.built ? 'Scene built — coverage not computed yet' : 'Package only — not built yet'}
          </div>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3,1fr)',
          borderTop: '1px solid #F1F5F6',
          background: '#FAFCFC',
        }}
      >
        <Stat label="Path gain" value={hasCov ? `${run.gain_db_max}…${run.gain_db_min}` : '—'} unit="dB" />
        <Stat label="Nodes" value={`${run.cells ?? 0}·${run.ues ?? 0}`} unit="gNB·UE" />
        <Stat label="Area" value={run.area ?? '—'} unit="" last />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '11px 18px', borderTop: '1px solid #F1F5F6' }}>
        <span style={{ fontSize: 12.5, color: '#8A9BA3', fontWeight: 600 }}>{run.started}</span>
        <span style={{ fontSize: 12.5, color: '#327985', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
          Open
          <Icon.chevronRight size={14} stroke="#327985" />
        </span>
      </div>
    </div>
  )
}

function Stat({ label, value, unit, last }: { label: string; value: string; unit: string; last?: boolean }) {
  return (
    <div style={{ padding: '11px 14px', borderRight: last ? 'none' : '1px solid #F1F5F6' }}>
      <div style={{ fontSize: 11, color: '#9AAAB1', fontWeight: 700, letterSpacing: '.2px' }}>{label}</div>
      <div style={{ fontSize: 13.5, fontWeight: 700, color: '#26343B', marginTop: 3, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {value}{' '}
        {unit && <span style={{ fontSize: 11, color: '#9AAAB1', fontWeight: 600 }}>{unit}</span>}
      </div>
    </div>
  )
}
