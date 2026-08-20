import { useEffect, useState } from 'react'
import { authHeader } from '../lib/auth'
import { useNavigate } from 'react-router-dom'
import { Icon } from '../components/Icon'
import { StatusPill } from '../components/ui'
import { sinrRamp } from '../styles/theme'
import type { Run } from '../lib/types'

export function CoverageRunDetail({ run }: { run: Run }) {
  const nav = useNavigate()
  const [overlay, setOverlay] = useState<string | null>(null)
  const [loadingOverlay, setLoadingOverlay] = useState(false)

  const scene = run.scene ?? run.name ?? 'Scene'
  const hasCov = run.has_coverage && run.coverage_pct != null

  useEffect(() => {
    if (!run.has_coverage) return
    let live = true
    setLoadingOverlay(true)
    fetch(`/api/runs/${run.id}/overlay`, { headers: authHeader() })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (live && d?.image) setOverlay(d.image)
      })
      .catch(() => {})
      .finally(() => live && setLoadingOverlay(false))
    return () => {
      live = false
    }
  }, [run.id, run.has_coverage])

  return (
    <div style={{ padding: '28px 34px 34px', color: '#0E1820' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <a onClick={() => nav('/runs')} style={{ cursor: 'pointer' }}>Runs</a>
            <Icon.chevronRight size={14} stroke="#A3B2B8" />
            <span className="sk-mono" style={{ fontSize: 14, fontWeight: 700 }}>{run.id}</span>
          </div>
          <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.7px', marginTop: 8 }}>{scene}</div>
          <div style={{ fontSize: 14, color: '#5B6E77', marginTop: 4, fontWeight: 500 }}>
            Sionna coverage run · {run.started}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <StatusPill label={run.state} fg={run.color} bg={run.bg} />
          <button className="sk-btn-ghost" onClick={() => nav('/builder')}>Open in 3D Twin</button>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 16, marginTop: 22 }}>
        <StatTile label="Coverage" value={hasCov ? `${run.coverage_pct}` : '—'} unit="%" accent="#327985" />
        <StatTile
          label="Path gain range"
          value={hasCov ? `${run.gain_db_max}…${run.gain_db_min}` : '—'}
          unit="dB"
          accent="#6093BA"
        />
        <StatTile label="Transmitters" value={run.cells ?? '0'} unit="gNB" accent="#3B4C54" />
        <StatTile label="Receivers" value={run.ues ?? '0'} unit="UE" accent="#3B4C54" />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 22, marginTop: 22 }}>
        <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ fontSize: 16, fontWeight: 800 }}>Coverage overlay</div>
            <div style={{ fontSize: 12.5, color: '#6D8E99', fontWeight: 600 }}>RadioMapSolver · path gain (dB)</div>
          </div>
          <div
            style={{
              position: 'relative',
              margin: '0 16px 16px',
              minHeight: 360,
              borderRadius: 12,
              overflow: 'hidden',
              background: '#0E1820',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {overlay ? (
              <img
                src={overlay}
                alt="Coverage overlay"
                style={{ width: '100%', height: '100%', objectFit: 'contain', imageRendering: 'pixelated' }}
              />
            ) : (
              <div style={{ color: '#7C9099', fontSize: 14, fontWeight: 600, textAlign: 'center', padding: 30 }}>
                {run.has_coverage
                  ? loadingOverlay
                    ? 'Loading coverage overlay…'
                    : 'No overlay'
                  : run.built
                    ? 'No coverage'
                    : 'Not built'}
              </div>
            )}
            {hasCov && (
              <div style={{ position: 'absolute', bottom: 14, left: 14, background: 'rgba(255,255,255,.95)', border: '1px solid #DDE7E7', borderRadius: 11, padding: '11px 14px', minWidth: 200 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: '#3B4C54' }}>Path gain (dB)</div>
                <div style={{ height: 9, borderRadius: 5, marginTop: 8, background: sinrRamp }} />
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#6B7C85', fontWeight: 600, marginTop: 5 }}>
                  <span>{run.gain_db_min}</span>
                  <span>{run.gain_db_max}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>Run details</div>
          {[
            ['Scene', scene],
            ['Run ID', run.id],
            ['State', run.state],
            ['Area', run.area ?? '—'],
            ['Coverage', hasCov ? `${run.coverage_pct}% of cells` : '—'],
            ['Gain min', hasCov ? `${run.gain_db_min} dB` : '—'],
            ['Gain max', hasCov ? `${run.gain_db_max} dB` : '—'],
            ['Computed at', run.started],
          ].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5, paddingBottom: 12, borderBottom: '1px solid #F1F5F6' }}>
              <span style={{ color: '#84969E', fontWeight: 600 }}>{k}</span>
              <span className={k === 'Run ID' ? 'sk-mono' : ''} style={{ fontWeight: 700, maxWidth: '60%', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {v}
              </span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: '#9AAAB1', fontWeight: 500, lineHeight: 1.5 }}>
            This run is a real Sionna RadioMapSolver computation over the built scene. Values are the
            actual path-gain statistics reported by the solver.
          </div>
        </div>
      </div>
    </div>
  )
}

function StatTile({ label, value, unit, accent }: { label: string; value: string; unit: string; accent: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #E2E9EA', borderRadius: 16, padding: '16px 20px' }}>
      <div style={{ fontSize: 12.5, color: '#5C6E76', fontWeight: 600 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, marginTop: 6 }}>
        <span style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-.6px', color: accent }}>{value}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: '#9AAAB1' }}>{unit}</span>
      </div>
    </div>
  )
}
