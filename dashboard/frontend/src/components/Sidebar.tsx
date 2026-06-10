import { BrandMark } from './ui'
import { useState } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Icon } from './Icon'
import type { RouteKey } from '../lib/types'
import { useAuth } from '../lib/useAuth'

const PANEL_BG = 'linear-gradient(180deg, #275578 0%, #1F4866 100%)'
const PANEL_BORDER = 'rgba(191,211,228,0.22)'
const ACTIVE_BOX = 'rgba(255,255,255,0.13)'
const ACTIVE_LEDGE = '#EA9EBF'
const IDLE_FG = '#DCE6EF'
const LABEL_FG = '#BFD3E4'
const GLASS_ITEM = 'rgba(255,255,255,0.08)'
const GLASS_ITEM_BORDER = 'rgba(255,255,255,0.14)'
const CARD_BG = 'rgba(255,255,255,0.07)'

export const SIDEBAR_W = 260
export const SIDEBAR_W_COLLAPSED = 76

const CHILDREN: Record<string, { path: string; label: string }[]> = {
  simulation: [
    { path: '/simulation', label: 'Ray Trace' },
    { path: '/simulation/handover', label: 'Handover' },
  ],
}

const NAV: { key: RouteKey; label: string; icon: keyof typeof Icon }[] = [
  { key: 'home', label: 'Dashboard', icon: 'dashboard' },
  { key: 'deployments', label: 'Deployments', icon: 'deploy' },
  { key: 'topology', label: 'Topology', icon: 'topology' },
  { key: 'agents', label: 'Agents', icon: 'agents' },
  { key: 'servers', label: 'Servers', icon: 'servers' },
  { key: 'scenes', label: 'Scenes', icon: 'scenes' },
  { key: 'builder', label: 'Scenario Builder', icon: 'builder' },
  { key: 'simulation', label: 'Simulation', icon: 'twin' },
  { key: 'runs', label: 'Runs', icon: 'runs' },
  { key: 'lake', label: 'Data Lake', icon: 'lake' },
  { key: 'studio', label: 'AI Studio', icon: 'studio' },
  { key: 'admin', label: 'Admin', icon: 'admin' },
]

function routeOf(pathname: string): string {
  const seg = pathname.split('/')[1] || 'home'
  if (seg === 'run') return 'runs'
  return seg
}

export function Sidebar({
  collapsed,
  onToggle,
}: {
  collapsed: boolean
  onToggle: () => void
}) {
  const nav = useNavigate()
  const loc = useLocation()
  const [openSection, setOpenSection] = useState<string | null>(null)
  const active = routeOf(loc.pathname)
  const { role } = useAuth()

  const w = collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W

  return (
    <div
      style={{
        width: w,
        flex: `0 0 ${w}px`,
        background: PANEL_BG,
        backdropFilter: 'blur(16px) saturate(1.2)',
        WebkitBackdropFilter: 'blur(16px) saturate(1.2)',
        borderRight: `1px solid ${PANEL_BORDER}`,
        display: 'flex',
        flexDirection: 'column',
        padding: '22px 0 20px',
        color: IDLE_FG,
        height: '100vh',
        position: 'sticky',
        top: 0,
        zIndex: 5,
        transition: 'width .22s cubic-bezier(.4,0,.2,1), flex-basis .22s cubic-bezier(.4,0,.2,1)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: collapsed ? '0 0 22px' : '0 18px 22px',
          justifyContent: collapsed ? 'center' : 'flex-start',
        }}
      >
        <div style={{ flex: collapsed ? '0 0 auto' : 1, minWidth: 0 }}>
          <BrandMark compact={collapsed} />
        </div>
        {!collapsed && (
          <button onClick={onToggle} title="Collapse" style={toggleBtn}>
            <Icon.chevronRight size={16} stroke="#9DB6BD" style={{ transform: 'rotate(180deg)' }} />
          </button>
        )}
      </div>

      {collapsed && (
        <button onClick={onToggle} title="Expand" style={{ ...toggleBtn, margin: '0 auto 12px' }}>
          <Icon.chevronRight size={16} stroke="#9DB6BD" />
        </button>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {NAV.filter((item) => item.key !== 'admin' || role !== 'viewer').map((item) => {
          const on = active === item.key
          const IconC = Icon[item.icon]
          const kids = openSection === item.key && !collapsed ? (CHILDREN[item.key] || []) : []
          return (
            <div key={item.key}>
            <div
              onClick={() => {
                const kidsOf = CHILDREN[item.key]
                if (kidsOf) {
                  const opening = openSection !== item.key
                  setOpenSection(opening ? item.key : null)
                  if (opening) nav(kidsOf[0].path)
                  return
                }
                setOpenSection(null)
                nav(item.key === 'home' ? '/' : `/${item.key}`)
              }}
              title={collapsed ? item.label : undefined}
              className={`sk-navtext${on ? ' is-active' : ''}`}
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                gap: 13,
                padding: collapsed ? '12px 0' : '12px 20px',
                justifyContent: collapsed ? 'center' : 'flex-start',
                cursor: 'pointer',
                fontSize: 15,
                fontWeight: on ? 700 : 600,
                whiteSpace: 'nowrap',
                color: '#FFFFFF',
                background: on ? ACTIVE_BOX : 'transparent',
              }}
            >
              {on && (
                <span
                  style={{
                    position: 'absolute',
                    right: 0,
                    top: 0,
                    bottom: 0,
                    width: 4,
                    background: ACTIVE_LEDGE,
                  }}
                />
              )}
              <IconC size={20} stroke="#FFFFFF" />
              {!collapsed && item.label}
            </div>

            {kids.map((c) => {
              const childOn = (loc.pathname.replace(/\/+$/, '') || '/simulation') === c.path
              return (
                <div
                  key={c.path}
                  onClick={() => nav(c.path)}
                  className="sk-navtext"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '9px 20px 9px 53px',
                    cursor: 'pointer',
                    fontSize: 13.5,
                    fontWeight: childOn ? 700 : 550,
                    whiteSpace: 'nowrap',
                    color: childOn ? '#FFFFFF' : 'rgba(255,255,255,.72)',
                    background: childOn ? 'rgba(255,255,255,.10)' : 'transparent',
                  }}
                >
                  <span style={{
                    width: 5, height: 5, borderRadius: '50%', flex: '0 0 auto',
                    background: childOn ? ACTIVE_LEDGE : 'rgba(255,255,255,.45)',
                  }} />
                  {c.label}
                </div>
              )
            })}
            </div>
          )
        })}
      </div>

    </div>
  )
}

const toggleBtn: React.CSSProperties = {
  width: 30,
  height: 30,
  flex: '0 0 30px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,.14)',
  background: 'rgba(255,255,255,.06)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  cursor: 'pointer',
  padding: 0,
}
