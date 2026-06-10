import { useEffect, useMemo, useState } from 'react'
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom'
import { Sidebar, SIDEBAR_W, SIDEBAR_W_COLLAPSED } from './components/Sidebar'
import { PageBackground } from './components/PageBackground'
import { AgentDock } from './components/AgentDock'
import { TerminalDock } from './components/TerminalDock'
import { JobBar } from './components/JobBar'
import { DataContext, type DataState } from './lib/useData'
import { AuthContext, canChange, useAuth } from './lib/useAuth'
import { fetchMe, logout, type Role } from './lib/auth'
import { api } from './lib/api'
import { MOCK } from './lib/mockData'
import type { Collections } from './lib/types'

import { ScreenLogin } from './screens/ScreenLogin'
import { ScreenHome } from './screens/ScreenHome'
import { ScreenScenes } from './screens/ScreenScenes'
import { ScreenTwin } from './screens/ScreenTwin'
import { ScreenSimulation } from './screens/ScreenSimulation'
import { ScreenHandover } from './screens/ScreenHandover'
import { ScreenRuns } from './screens/ScreenRuns'
import { ScreenRunHistory } from './screens/ScreenRunHistory'
import { ScreenDataLake } from './screens/ScreenDataLake'
import { ScreenRunDetail } from './screens/ScreenRunDetail'
import { ScreenStudio } from './screens/ScreenStudio'
import { ScreenAgents } from './screens/ScreenAgents'
import { ScreenServers } from './screens/ScreenServers'
import { ScreenAdmin } from './screens/ScreenAdmin'
import { ScreenDeployments } from './screens/ScreenDeployments'
import { ScreenTopology } from './screens/ScreenTopology'

export interface Density {
  pad: string
  font: string
}

function Shell({
  collapsed,
  setCollapsed,
  user,
}: {
  collapsed: boolean
  setCollapsed: (v: boolean) => void
  user: string
}) {
  const loc = useLocation()
  const { role } = useAuth()
  useEffect(() => {
    document.getElementById('sk-scroll')?.scrollTo(0, 0)
  }, [loc.pathname])

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden', position: 'relative' }}>
      <PageBackground
        sidebarWidth={collapsed ? SIDEBAR_W_COLLAPSED : SIDEBAR_W}
        mode={loc.pathname === '/' ? 'image' : 'sky'}
      />
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative', zIndex: 1 }}>
        <JobBar />
        <div id="sk-scroll" style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
          <div key={loc.pathname} className="sk-fade-in" style={{ minHeight: '100%', position: 'relative', zIndex: 1 }}>
            <Routes>
              <Route path="/" element={<ScreenHome />} />
              <Route path="/deployments" element={<ScreenDeployments />} />
              <Route path="/topology" element={<ScreenTopology />} />
              <Route path="/agents" element={<ScreenAgents />} />
              <Route path="/servers" element={<ScreenServers />} />
              <Route path="/scenes" element={<ScreenScenes />} />
              <Route path="/builder" element={<ScreenTwin />} />
              <Route path="/simulation" element={<ScreenSimulation />} />
              <Route path="/simulation/handover" element={<ScreenHandover />} />
              <Route path="/runs" element={<ScreenRunHistory />} />
              <Route path="/runs/coverage" element={<ScreenRuns />} />
              <Route path="/run/:id" element={<ScreenRunDetail />} />
              <Route path="/lake" element={<ScreenDataLake />} />
              <Route path="/studio" element={<ScreenStudio />} />
              <Route path="/admin" element={role === 'viewer' ? <Navigate to="/" replace /> : <ScreenAdmin />} />
            </Routes>
          </div>
        </div>
      </div>
      {canChange(role) && <><AgentDock /><TerminalDock /></>}
    </div>
  )
}

export default function App() {
  const [data, setData] = useState<Collections>(MOCK)
  const [source, setSource] = useState<'backend' | 'mock'>('mock')
  const [loading, setLoading] = useState(true)
  const [collapsed, setCollapsed] = useState(false)

  const [user, setUser] = useState<string | null>(null)
  const [role, setRole] = useState<Role>('viewer')
  const [authChecked, setAuthChecked] = useState(false)
  const adopt = (m: { user: string; role: Role } | null) => { setUser(m?.user ?? ''); setRole(m?.role ?? 'viewer') }

  useEffect(() => {
    let live = true
    fetchMe()
      .then((m) => {
        if (live) adopt(m)
      })
      .finally(() => live && setAuthChecked(true))
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!user) return
    let live = true
    api
      .collections()
      .then((c) => {
        if (!live) return
        setData(c)
        return fetch('/api/health')
          .then((r) => setSource(r.ok ? 'backend' : 'mock'))
          .catch(() => setSource('mock'))
      })
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [user])

  const ctx: DataState = useMemo(() => ({ data, loading, source }), [data, loading, source])

  const handleLogout = async () => {
    await logout()
    setUser('')
  }

  if (!authChecked) {
    return <div style={{ height: '100vh', background: '#EEF3F4' }} />
  }

  if (!user) {
    return <ScreenLogin onSuccess={() => fetchMe().then(adopt)} />
  }

  return (
    <AuthContext.Provider value={{ user, role, onLogout: handleLogout }}>
      <DataContext.Provider value={ctx}>
        <BrowserRouter>
          <Shell
            collapsed={collapsed}
            setCollapsed={setCollapsed}
            user={user}
          />
        </BrowserRouter>
      </DataContext.Provider>
    </AuthContext.Provider>
  )
}
