import { font } from '../styles/theme'
import { UserChip } from './TopBar'
import type { CSSProperties, ReactNode } from 'react'

export function StatusPill({
  label,
  fg,
  bg,
  dot = true,
}: {
  label: string
  fg: string
  bg: string
  dot?: boolean
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        borderRadius: 999,
        padding: '6px 13px',
        fontSize: 12.5,
        fontWeight: 700,
        background: bg,
        color: fg,
      }}
    >
      {dot && (
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: fg }} />
      )}
      {label}
    </span>
  )
}

export function Card({
  children,
  style,
  pad = 22,
}: {
  children: ReactNode
  style?: CSSProperties
  pad?: number | string
}) {
  return (
    <div
      style={{
        background: '#fff',
        border: '1px solid #E2E9EA',
        borderRadius: 16,
        padding: typeof pad === 'number' ? `${pad}px` : pad,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 50 }}>
      <div>
        <div style={{ fontSize: 30, fontWeight: 800, letterSpacing: '-.9px', lineHeight: 1.1 }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 15, color: '#5B6E77', marginTop: 6, fontWeight: 500, maxWidth: 720 }}>
            {subtitle}
          </div>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>{actions}<UserChip /></div>
    </div>
  )
}

export function ImageSlot({
  label,
  kind = 'render',
  style,
}: {
  label: string
  kind?: 'render' | 'photo' | 'thumb'
  style?: CSSProperties
}) {
  const grad =
    kind === 'photo'
      ? 'linear-gradient(135deg,#CFDDE8,#E7F0F1 55%,#DBE8EA)'
      : 'linear-gradient(135deg,#DBE8EA,#EEF4F5 60%,#E2ECEE)'
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: grad,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          color: '#7C9099',
          fontSize: 13,
          fontWeight: 600,
          background: 'rgba(255,255,255,.6)',
          border: '1px dashed #B9CDCE',
          borderRadius: 10,
          padding: '9px 16px',
          maxWidth: '80%',
          textAlign: 'center',
        }}
      >
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#8AA0A8" strokeWidth="1.7">
          <rect x="3" y="4" width="18" height="16" rx="3" />
          <path d="M3 16l5-4 4 3 4-5 5 4" />
          <circle cx="8.5" cy="9" r="1.6" />
        </svg>
        {label}
      </div>
    </div>
  )
}

export function SegTabs({
  options,
  active,
  onChange,
}: {
  options: string[]
  active: string
  onChange?: (v: string) => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        background: '#F3F7F8',
        border: '1px solid #E7EEEF',
        borderRadius: 9,
        padding: 3,
      }}
    >
      {options.map((o) => {
        const on = o === active
        return (
          <button
            key={o}
            onClick={() => onChange?.(o)}
            style={{
              padding: '6px 14px',
              fontSize: 12.5,
              fontWeight: 700,
              color: on ? '#327985' : '#6D8E99',
              background: on ? '#fff' : 'transparent',
              borderRadius: 7,
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {o}
          </button>
        )
      })}
    </div>
  )
}

export function EmptyOr({
  when,
  fallback,
  children,
}: {
  when: boolean
  fallback: ReactNode
  children: ReactNode
}) {
  return <>{when ? fallback : children}</>
}

export function BrandMark({ size = 42, compact = false, onDark = true }: { size?: number; compact?: boolean; onDark?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      <img src="/tossi-logo.png" alt="TOSSI" width={size} height={size}
        style={{ flex: `0 0 ${size}px`, borderRadius: 12, display: 'block', background: '#fff' }} />
      {!compact && (
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 21, fontWeight: 800, letterSpacing: '-.4px', fontFamily: font.display,
                        color: onDark ? '#FFFFFF' : '#275578' }}>TOSSI</div>
          <div style={{ fontSize: 11.5, fontWeight: 500, marginTop: 1, color: onDark ? '#BFD3E4' : '#6D8E99' }}>
            Open AI-RAN Testbed
          </div>
        </div>
      )}
    </div>
  )
}
