import React, { useState } from 'react'

export const T = {
  panel: 'linear-gradient(135deg, rgba(247,250,251,.96) 0%, rgba(247,250,251,.93) 45%, rgba(247,250,251,.90) 100%)',
  ink: '#0E1820',
  mut: '#5B6E77',
  dim: '#9AAAB1',
  bd: '#E2E9EA',
  bdBrand: '#C2D7DA',
  fill: '#F3F7F8',
  fillBrand: '#F2F9FB',
  card: 'rgba(255,255,255,.86)',
  brand: '#327985',
  brandFill: '#327985',
  warn: '#A56C08',
  bad: '#B3272C',
  badLine: '#F0CFD0',
}

export const S = { xs: 6, sm: 10, md: 14, lg: 18 }

export function Section({ n, title, hint, summary, open, onToggle, children }: {
  n: number; title: string; hint?: string; summary?: string
  open: boolean; onToggle: () => void; children: React.ReactNode
}) {
  return (
    <div style={{ borderBottom: '1px solid ' + T.bd, padding: `${S.md}px ${S.lg}px` }}>
      <div onClick={onToggle} title={open ? 'Collapse' : 'Open'}
        style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                 marginBottom: open ? S.sm : 0 }}>
        <span style={{ flex: '0 0 auto', width: 18, height: 18, borderRadius: '50%',
                       display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                       fontSize: 10.5, fontWeight: 800,
                       background: open ? T.brandFill : T.fill,
                       color: open ? '#fff' : T.mut,
                       border: '1px solid ' + (open ? T.brandFill : T.bd) }}>{n}</span>
        <span style={{ flex: '1 1 auto', minWidth: 0, fontSize: 13, fontWeight: 800,
                       letterSpacing: '-.2px', whiteSpace: 'nowrap', overflow: 'hidden',
                       textOverflow: 'ellipsis' }}>{title}</span>
        <span style={{ flex: '0 1 auto', minWidth: 0, fontSize: 11.5, color: T.mut, fontWeight: 700,
                       overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       textAlign: 'right' }}>{open ? hint : (summary || hint)}</span>
        <Caret open={open} />
      </div>
      {open && children}
    </div>
  )
}

export function Caret({ open }: { open: boolean }) {
  return (
    <span style={{ flex: '0 0 auto', width: 0, height: 0, marginLeft: 2,
                   borderLeft: '4px solid transparent', borderRight: '4px solid transparent',
                   borderTop: `5px solid ${T.dim}`,
                   transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
                   transition: 'transform .15s ease' }} />
  )
}

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginTop: S.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: S.xs }}>
        <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.7px',
                       textTransform: 'uppercase', color: T.dim }}>{title}</span>
        <span style={{ flex: 1, height: 1, background: T.bd }} />
      </div>
      {children}
    </div>
  )
}

export function FieldLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 700, marginBottom: 4 }}>{children}</div>
}

export function SectionHead({ title, subtitle, aside }: {
  title: string; subtitle?: string; aside?: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap',
                  paddingBottom: 7, marginBottom: 9, borderBottom: '1px solid ' + T.bd }}>
      <span style={{ fontSize: 14, fontWeight: 800, letterSpacing: '-.25px', color: T.ink }}>
        {title}
      </span>
      {subtitle && (
        <span style={{ fontSize: 11.5, color: T.mut, fontWeight: 500, flex: 1, minWidth: 0 }}>
          {subtitle}
        </span>
      )}
      {aside}
    </div>
  )
}

export type Tone = 'neutral' | 'brand' | 'good' | 'warn' | 'bad'

export const TONES: Record<Tone, { fg: string; bg: string; bd: string }> = {
  neutral: { fg: T.ink, bg: T.fill, bd: T.bd },
  brand: { fg: T.brand, bg: T.fillBrand, bd: T.bdBrand },
  good: { fg: '#0A7A4A', bg: '#E8F6EF', bd: '#BFE3D2' },
  warn: { fg: '#8A5B0B', bg: '#FFF6E5', bd: '#F0DCB4' },
  bad: { fg: T.bad, bg: '#FDECEA', bd: T.badLine },
}

export function Panel({ tone = 'neutral', rail, children, style }: {
  tone?: Tone; rail?: boolean; children: React.ReactNode; style?: React.CSSProperties
}) {
  const t = TONES[tone]
  return (
    <div style={{
      border: '1px solid ' + t.bd,
      borderLeft: rail ? '3px solid ' + t.fg : '1px solid ' + t.bd,
      background: t.bg,
      borderRadius: 10,
      padding: '11px 13px',
      ...style,
    }}>{children}</div>
  )
}

export function Eyebrow({ tone = 'brand', children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.09em',
                  textTransform: 'uppercase', color: TONES[tone].fg, marginBottom: 5 }}>
      {children}
    </div>
  )
}

export function Figure({ value, caption, tone = 'brand', size = 26 }: {
  value: React.ReactNode; caption?: React.ReactNode; tone?: Tone; size?: number
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
      <span className="sk-mono" style={{ fontSize: size, fontWeight: 700, lineHeight: 1.1,
        letterSpacing: '-.4px', color: TONES[tone].fg, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
      {caption && (
        <span style={{ fontSize: 12.5, color: T.mut, fontWeight: 600 }}>{caption}</span>
      )}
    </div>
  )
}

export function Note({ children, style }: {
  children: React.ReactNode; style?: React.CSSProperties
}) {
  return (
    <div style={{ fontSize: 12, color: T.mut, fontWeight: 500, lineHeight: 1.55,
                  marginTop: 5, ...style }}>{children}</div>
  )
}

export function Chip({ tone = 'neutral', children }: { tone?: Tone; children: React.ReactNode }) {
  const t = TONES[tone]
  return (
    <span style={{ border: '1px solid ' + t.bd, background: tone === 'neutral' ? '#fff' : t.bg,
                   color: tone === 'neutral' ? T.ink : t.fg, borderRadius: 8,
                   padding: '3px 9px', fontSize: 11.5, fontWeight: 600,
                   whiteSpace: 'nowrap' }}>{children}</span>
  )
}

export function Toggle({ active, onClick, children }: {
  active?: boolean; onClick: () => void; children: React.ReactNode
}) {
  return (
    <button onClick={onClick}
      style={{ border: '1px solid ' + (active ? T.bdBrand : T.bd),
               background: active ? T.fillBrand : '#fff',
               color: active ? T.brand : T.mut, borderRadius: 8, padding: '5px 11px',
               fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
      {children}
    </button>
  )
}

export function ListFrame({ children, maxHeight = 300 }: {
  children: React.ReactNode; maxHeight?: number
}) {
  return (
    <div style={{ border: '1px solid ' + T.bd, borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ maxHeight, overflowY: 'auto' }}>{children}</div>
    </div>
  )
}

export function Actions({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: S.xs, flexWrap: 'wrap', marginTop: S.md,
                  paddingTop: S.sm, borderTop: '1px solid ' + T.bd }}>{children}</div>
  )
}

export function Readout({ label, value, mono, tone, sub }: {
  label: string; value: string; mono?: boolean; tone?: 'ok' | 'warn'
  sub?: string
}) {
  const color = tone === 'warn' ? T.warn : tone === 'ok' ? T.brand : T.ink
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
                  gap: 10, padding: '3px 0', minWidth: 0 }}>
      <span style={{ fontSize: 12.5, color: T.mut, fontWeight: 600, flex: '0 1 auto',
                     minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
                     whiteSpace: 'nowrap' }}>{label}</span>
      <span className={mono ? 'sk-mono' : undefined}
        title={sub ? `${value} · ${sub}` : value}
        style={{ fontSize: 12.5, fontWeight: 700, color, textAlign: 'right',
                 flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere',
                 fontVariantNumeric: 'tabular-nums' }}>
          {value}
          {sub && <span style={{ color: T.mut, fontWeight: 600, marginLeft: 6 }}>{sub}</span>}
        </span>
    </div>
  )
}

export function SelectField({ label, value, onChange, options, labels }: {
  label: string; value: string; onChange: (v: string) => void; options: string[]; labels?: string[]
}) {
  return (
    <label style={{ flex: 1, minWidth: 0, display: 'block' }}>
      <div style={{ fontSize: 11.5, color: T.mut, fontWeight: 700, marginBottom: 4 }}>{label}</div>
      <select value={value} onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', border: '1px solid ' + T.bd, borderRadius: 8, padding: '6px 9px',
                 fontSize: 13, fontWeight: 600, fontFamily: 'inherit', color: T.ink, background: T.card }}>
        {options.map((o, i) => <option key={o + i} value={o}>{labels?.[i] ?? o}</option>)}
      </select>
    </label>
  )
}

export function Hint({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
  return (
    <div style={{
      marginTop: 9, fontSize: 11.5, lineHeight: 1.5, fontWeight: 500,
      color: tone === 'warn' ? '#8A5B0B' : T.mut,
      background: tone === 'warn' ? 'rgba(240,168,60,.14)' : 'transparent',
      border: tone === 'warn' ? '1px solid #F3E2C4' : 'none',
      borderRadius: 8, padding: tone === 'warn' ? '7px 9px' : 0,
    }}>{children}</div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12.5, color: T.dim, fontWeight: 600, padding: '4px 0' }}>{children}</div>
}

export function Tag({ children, muted }: { children: React.ReactNode; muted?: boolean }) {
  return (
    <span style={{ background: T.fill, borderRadius: 6, padding: '3px 9px', fontSize: 12, fontWeight: 800, color: muted ? T.mut : T.mut, whiteSpace: 'nowrap' }}>{children}</span>
  )
}

export function Dot({ ok, label, pulse }: { ok: boolean; label: string; pulse?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700, color: ok ? T.brand : T.warn, whiteSpace: 'nowrap' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: ok ? T.brand : T.warn, animation: pulse ? 'pulseDot 1.4s ease-in-out infinite' : undefined }} />
      {label}
    </span>
  )
}

export function Banner({ children, tone, onClose }: { children: React.ReactNode; tone?: 'error'; onClose?: () => void }) {
  const err = tone === 'error'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10, padding: '9px 22px', fontSize: 13, flex: '0 0 auto',
      background: err ? 'rgba(255,138,143,.14)' : 'rgba(240,168,60,.14)', color: err ? T.bad : T.warn,
      borderBottom: `1px solid ${err ? '#F6D4D5' : '#F3D9B8'}`,
    }}>
      <span style={{ flex: 1, whiteSpace: 'pre-wrap' }}>{children}</span>
      {onClose && <span onClick={onClose} style={{ cursor: 'pointer', fontWeight: 700 }}>✕</span>}
    </div>
  )
}

export function MenuItem({ label, hint, onClick, danger, disabled }: {
  label: string; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean
}) {
  const [hot, setHot] = useState(false)
  return (
    <div
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      style={{ cursor: disabled ? 'not-allowed' : 'pointer', borderRadius: 8,
               padding: hint ? '7px 11px' : '9px 11px',
               opacity: disabled ? 0.45 : 1,
               background: hot && !disabled ? (danger ? '#FDF2F2' : T.fillBrand) : 'transparent' }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: danger ? T.bad : T.ink }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: T.mut, fontWeight: 500, marginTop: 1 }}>{hint}</div>}
    </div>
  )
}
