import { useAuth } from '../lib/useAuth'

export const CHIP_ROW_H = 56

export function UserChip() {
  const { user, role, onLogout } = useAuth()
  const initials = user.trim().split(/[\s._-]+/).map((s) => s[0]).join('').slice(0, 2).toUpperCase() || 'U'
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, padding: '4px 4px 4px 14px', borderRadius: 999,
                  background: 'rgba(255,255,255,.78)', border: '1px solid rgba(226,233,234,.9)', color: '#0E1820' }}>
      <div style={{ textAlign: 'right', lineHeight: 1.15 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700 }}>{user}</div>
        <div style={{ fontSize: 11.5, color: role === 'viewer' ? '#B07908' : '#84969E', fontWeight: 600, textTransform: 'capitalize' }}>{role}</div>
      </div>
      <div style={{ width: 34, height: 34, borderRadius: '50%', border: '2px solid #E6EFF0', background: 'linear-gradient(135deg,#327985,#6093BA)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 13.5 }}>
        {initials}
      </div>
      <button onClick={onLogout}
        style={{ display: 'flex', alignItems: 'center', gap: 6, border: '1px solid #E7EEEF', background: '#fff', borderRadius: 999,
                 padding: '7px 12px', fontSize: 12.5, fontWeight: 700, color: '#3B4C54', cursor: 'pointer', fontFamily: 'inherit' }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5B6E77" strokeWidth="1.9">
          <path d="M15 12H4M9 7l-5 5 5 5M14 4h4a2 2 0 012 2v12a2 2 0 01-2 2h-4" />
        </svg>
        Sign out
      </button>
    </div>
  )
}
