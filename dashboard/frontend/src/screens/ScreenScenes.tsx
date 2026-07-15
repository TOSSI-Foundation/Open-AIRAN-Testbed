import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { PageHeader, ImageSlot } from '../components/ui'
import { Icon } from '../components/Icon'
import { useCollection } from '../lib/useData'
import type { Scene } from '../lib/types'
import { mapApi, isError } from '../lib/mapApi'
import { T, MenuItem } from './panelKit'
import { authHeader } from '../lib/auth'

const FILTERS = ['All', 'Coverage ready', 'Scene built', 'Package only']

function matchesFilter(s: Scene, filter: string): boolean {
  if (filter === 'All') return true
  if (filter === 'Coverage ready') return !!s.coverage
  if (filter === 'Scene built') return !!s.built
  if (filter === 'Package only') return !s.built && !s.coverage
  return true
}
const LAST_SCENE_KEY = 'tossi.twin.lastScene'
const RAYTRACE_SCENE_KEY = 'tossi.raytrace.lastScene'
const HANDOVER_SCENE_KEY = 'tossi.handover.lastScene'

function SceneThumb({ id, hasCoverage }: { id: string; hasCoverage: boolean }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasCoverage) return
    let live = true
    let made: string | null = null
    fetch(`/api/map/scenes/${id}/thumb`, { headers: authHeader() })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!live || !b) return
        made = URL.createObjectURL(b)
        setUrl(made)
      })
      .catch(() => {})
    return () => { live = false; if (made) URL.revokeObjectURL(made) }
  }, [id, hasCoverage])

  if (!url) return <ImageSlot label={hasCoverage ? 'Loading…' : 'No coverage'} kind="thumb" />
  return (
    <img src={url} alt="" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                                   objectFit: 'cover', display: 'block' }} />
  )
}

export function ScreenScenes() {
  const loaded = useCollection('scenes')
  const [rows, setRows] = useState(loaded)
  useEffect(() => { setRows(loaded) }, [loaded])
  const scenes = rows
  const [filter, setFilter] = useState('All')
  const [query, setQuery] = useState('')
  const nav = useNavigate()

  const shown = scenes.filter((s) => {
    const matchesQuery =
      !query ||
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.id.toLowerCase().includes(query.toLowerCase())
    if (!matchesQuery) return false
    return matchesFilter(s, filter)
  })

  const [sceneMenu, setSceneMenu] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [menuErr, setMenuErr] = useState<string | null>(null)

  useEffect(() => {
    if (!sceneMenu) return
    const close = () => { setSceneMenu(null); setConfirmDel(null); setRenaming(null) }
    window.addEventListener('click', close)
    return () => window.removeEventListener('click', close)
  }, [sceneMenu])

  function editInBuilder(id: string) {
    nav(`/builder?scene=${encodeURIComponent(id)}`)
  }

  function openInRayTrace(id: string) {
    localStorage.setItem(RAYTRACE_SCENE_KEY, id)
    nav('/simulation')
  }
  function openInHandover(id: string) {
    localStorage.setItem(HANDOVER_SCENE_KEY, id)
    nav('/simulation/handover')
  }

  async function commitRename(id: string) {
    const name = draftName.trim()
    if (!name) { setRenaming(null); return }
    const r = await mapApi.setSceneConfig(id, { name })
    if (isError(r)) { setMenuErr(r.error || 'Rename failed'); return }
    setRows((cur) => cur.map((s) => (s.id === id ? { ...s, name } : s)))
    setRenaming(null); setSceneMenu(null); setMenuErr(null)
  }

  async function removeScene(id: string) {
    const r = await mapApi.deleteScene(id)
    if (isError(r)) { setMenuErr(r.error || 'Delete failed'); return }
    for (const k of [LAST_SCENE_KEY, RAYTRACE_SCENE_KEY, HANDOVER_SCENE_KEY])
      if (localStorage.getItem(k) === id) localStorage.removeItem(k)
    setRows((cur) => cur.filter((s) => s.id !== id))
    setSceneMenu(null); setConfirmDel(null); setMenuErr(null)
  }

  return (
    <div style={{ padding: '18px 34px 34px', color: '#0E1820' }}>
      <PageHeader title="Scenes" />

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 22 }}>
        {FILTERS.map((f) => {
          const on = f === filter
          const count = scenes.filter((s) => matchesFilter(s, f)).length
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
              {f} · {count}
            </span>
          )
        })}
        <span
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
            background: '#fff',
            border: '1px solid #E2E9EA',
            borderRadius: 10,
            padding: '9px 14px',
            width: 280,
          }}
        >
          <Icon.search size={16} stroke="#8A9BA3" />
          <input
            placeholder="Search scenes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ border: 'none', outline: 'none', background: 'transparent', fontSize: 13.5, width: '100%', fontFamily: 'inherit' }}
          />
        </span>
      </div>

      {shown.length === 0 ? (
        <div
          style={{
            marginTop: 40,
            padding: '60px 40px',
            textAlign: 'center',
            background: '#fff',
            border: '1px solid #E2E9EA',
            borderRadius: 16,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 800 }}>No scenes</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 20, marginTop: 20 }}>
          {shown.map((sc) => (
            <div key={sc.id}
              onClick={(e) => {
                e.stopPropagation()
                setConfirmDel(null); setRenaming(null); setMenuErr(null)
                setSceneMenu((cur) => (cur === sc.id ? null : sc.id))
              }}
              style={{ background: '#fff', border: '1px solid ' + (sceneMenu === sc.id ? T.bdBrand : '#E2E9EA'), borderRadius: 16, display: 'flex', flexDirection: 'column', cursor: 'pointer', position: 'relative' }}>
              <div style={{ height: 190, position: 'relative', background: '#DDE7EA',
                            borderRadius: '16px 16px 0 0', overflow: 'hidden' }}>
                <SceneThumb id={sc.id} hasCoverage={!!sc.coverage} />
                <span style={{ position: 'absolute', top: 12, right: 12, borderRadius: 999, padding: '5px 12px', fontSize: 11.5, fontWeight: 800, background: sc.badgeBg, color: sc.badgeFg }}>
                  {sc.badge}
                </span>
              </div>
              <div style={{ padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div>
                  <div style={{ fontSize: 16.5, fontWeight: 800, letterSpacing: '-.2px' }}>{sc.name}</div>
                  <div style={{ fontSize: 12.5, color: '#6D8E99', marginTop: 4, fontWeight: 600 }}>
                    {sc.city && sc.city !== sc.name ? sc.city : null}
                    {sc.city && sc.city !== sc.name ? ' · ' : null}
                    <span className="sk-mono">{sc.id}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 18, fontSize: 13, color: '#3B4C54', fontWeight: 600 }}>
                  <span>{sc.area}</span>
                  <span>{sc.buildings}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10, borderTop: '1px solid #F1F5F6' }}>
                  <span style={{ fontSize: 12.5, color: '#6D8E99', fontWeight: 600 }}>{sc.source}</span>
                  <span style={{ fontSize: 12.5, color: '#9AAAB1', fontWeight: 600 }}>{sc.updated}</span>
                </div>
              </div>

              {sceneMenu === sc.id && (
                <div onClick={(e) => e.stopPropagation()}
                  style={{ position: 'absolute', top: '50%', left: 14, right: 14, zIndex: 30,
                           transform: 'translateY(-50%)',
                           background: '#fff', border: '1px solid ' + T.bd, borderRadius: 12,
                           boxShadow: '0 16px 40px rgba(14,26,32,.22)', padding: 5 }}>

                  {renaming === sc.id ? (
                    <div style={{ padding: '6px 7px' }}>
                      <input
                        autoFocus
                        value={draftName}
                        onChange={(e) => setDraftName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void commitRename(sc.id)
                          if (e.key === 'Escape') { setRenaming(null); setMenuErr(null) }
                        }}
                        placeholder="Name"
                        maxLength={80}
                        style={{ width: '100%', boxSizing: 'border-box', fontSize: 12.5, fontWeight: 700,
                                 padding: '7px 9px', borderRadius: 8, border: '1px solid ' + T.bdBrand,
                                 color: T.ink, outline: 'none' }} />
                      <div style={{ display: 'flex', gap: 7, marginTop: 7 }}>
                        <button onClick={() => void commitRename(sc.id)} className="sk-btn-primary"
                          style={{ flex: 1, fontSize: 12, padding: '6px 0' }}>Save</button>
                        <button onClick={() => { setRenaming(null); setMenuErr(null) }} className="sk-btn-ghost"
                          style={{ flex: 1, fontSize: 12, padding: '6px 0' }}>Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <MenuItem label="Edit" onClick={() => editInBuilder(sc.id)} />
                      <MenuItem label="Open in Ray Trace"
                        hint={sc.built ? undefined : 'not built'}
                        disabled={!sc.built}
                        onClick={() => openInRayTrace(sc.id)} />
                      <MenuItem label="Open in Handover"
                        hint={sc.built ? undefined : 'not built'}
                        disabled={!sc.built}
                        onClick={() => openInHandover(sc.id)} />
                      <MenuItem label="Rename"
                        onClick={() => { setDraftName(sc.name ?? ''); setRenaming(sc.id) }} />
                      {confirmDel === sc.id ? (
                        <MenuItem label="Delete permanently" danger
                          onClick={() => void removeScene(sc.id)} />
                      ) : (
                        <MenuItem label="Delete" danger
                          onClick={() => setConfirmDel(sc.id)} />
                      )}
                    </>
                  )}

                  {menuErr && (
                    <div style={{ fontSize: 11.5, color: T.bad, fontWeight: 600, padding: '6px 10px 2px' }}>
                      {menuErr}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
