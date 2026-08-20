import { useEffect, useState } from 'react'
import { authHeader } from '../lib/auth'
import { T, S, FieldLabel, Readout, Hint,
         Panel, Figure, Note, Chip } from './panelKit'

type Span = { min: number; max: number; n: number } | null

type Enrichment = {
  ok?: boolean
  enriched?: boolean
  how?: string
  positions_traced?: number
  updates_covered?: number
  max_depth?: number
  cells?: string[]
  los?: { true: number; of: number } | null
  dist_m?: Span
  n_paths_traced?: Span
  rms_delay_spread_s?: Span
  first_arrival_s?: Span
  strongest_share?: Span
  strongest_bounces?: Span
  interactions?: Record<string, { min: number; max: number; total: number }>
}

const range = (s: Span, fmt: (v: number) => string): string => {
  if (!s) return '—'
  return s.min === s.max ? fmt(s.min) : `${fmt(s.min)} to ${fmt(s.max)}`
}
const ns = (v: number) => `${(v * 1e9).toFixed(v * 1e9 < 10 ? 2 : 1)} ns`
const us = (v: number) => `${(v * 1e6).toFixed(2)} µs`
const m = (v: number) => `${v.toFixed(0)} m`
const pct = (v: number) => `${(v * 100).toFixed(0)}%`
const int = (v: number) => String(v)

export function EnrichmentPanel({ runId }: { runId: string }) {
  const [en, setEn] = useState<Enrichment | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')

  useEffect(() => {
    let alive = true
    setStatus('loading')
    void (async () => {
      try {
        const d = await (await fetch(`/api/recordings/${runId}/enrichment`, { headers: authHeader() })).json()
        if (!alive) return
        if (d?.ok === false) { setStatus('error'); return }
        setEn(d)
        setStatus('ready')
      } catch { if (alive) setStatus('error') }
    })()
    return () => { alive = false }
  }, [runId])

  if (status !== 'ready' || !en) return null

  if (!en.enriched) {
    return (
      <div style={{ marginTop: S.md }}>
        <FieldLabel>What the solve knew</FieldLabel>
        <Hint>
          Not re-traced yet, so the channel detail this run computed is still unrecovered —
          line of sight, delay spread and the path composition. Re-tracing is offered under
          Training data below, and handover prediction needs it too.
        </Hint>
      </div>
    )
  }

  const los = en.los
  const inter = en.interactions ?? {}
  const kinds = Object.entries(inter).filter(([, v]) => v.total > 0)

  return (
    <div style={{ marginTop: S.md }}>
      <FieldLabel>What the solve knew</FieldLabel>

      {los && los.of > 0 && (
        <Panel tone="brand" rail style={{ marginBottom: 8 }}>
          <Figure size={20} value={`${los.true} of ${los.of}`}
            caption="positions had the transmitter in view" />
          <Note>
            {los.true === los.of
              ? 'Line of sight everywhere along the route, so the signal fell with distance rather than with blockage.'
              : los.true === 0
                ? 'The transmitter was never directly visible; every position was reached by reflection or refraction alone.'
                : `${los.of - los.true} position${los.of - los.true === 1 ? ' was' : 's were'} reached without a direct path — that is where blockage, not distance, is what moved the signal.`}
          </Note>
        </Panel>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14 }}>
        <div>
          <Readout label="Distance to cell" value={range(en.dist_m ?? null, m)} />
          <Readout label="Propagation paths" value={range(en.n_paths_traced ?? null, int)} />
          <Readout label="Dominant path bounces" value={range(en.strongest_bounces ?? null, int)} />
        </div>
        <div>
          <Readout label="Delay spread" value={range(en.rms_delay_spread_s ?? null, ns)} />
          <Readout label="First arrival" value={range(en.first_arrival_s ?? null, us)} />
          <Readout label="Dominant path carries" value={range(en.strongest_share ?? null, pct)} />
        </div>
      </div>

      {kinds.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap',
                      alignItems: 'center' }}>
          <span style={{ fontSize: 11, color: T.mut, fontWeight: 700 }}>How it got across:</span>
          {kinds.map(([kind, v]) => (
            <Chip key={kind}>
              {kind}
              <span className="sk-mono" style={{ color: T.mut, marginLeft: 5 }}>
                {v.min === v.max ? v.min : `${v.min}–${v.max}`}
              </span>
            </Chip>
          ))}

        </div>
      )}

      {en.cells && en.cells.length > 0 && (
        <Hint>
          {en.cells.length === 1
            ? `Signal recovered for one transmitter (${en.cells[0]}). A handover prediction needs a neighbour, so it has nothing to compare against on this scene.`
            : `Signal recovered for ${en.cells.length} transmitters (${en.cells.join(', ')}) — enough for a handover prediction to compare them.`}
        </Hint>
      )}
    </div>
  )
}

export function EnrichmentStatus({ runId }: { runId: string }) {
  const [en, setEn] = useState<Enrichment | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await (await fetch(`/api/recordings/${runId}/enrichment`, { headers: authHeader() })).json()
        if (alive && d?.ok !== false) setEn(d)
      } catch {  }
    })()
    return () => { alive = false }
  }, [runId])

  if (!en) return null
  return (
    <Readout label="Re-traced"
      value={en.enriched
        ? `${en.positions_traced} position${en.positions_traced === 1 ? '' : 's'}`
        : 'not yet'}
      tone={en.enriched ? undefined : 'warn'} />
  )
}
