import { useCallback, useEffect, useRef, useState } from 'react'

export interface Anchor { right: number; bottom: number }
export interface Size { w: number; h: number }

const load = (key: string, def: Anchor): Anchor => {
  try { const v = JSON.parse(localStorage.getItem(key) || ''); if (typeof v.right === 'number' && typeof v.bottom === 'number') return v } catch {  }
  return def
}

export function useFloating(key: string, def: Anchor, defSize: Size = { w: 440, h: 620 }) {
  const [at, setAt] = useState<Anchor>(() => load(key, def))
  const [size, setSize] = useState<Size>(() => {
    try { const v = JSON.parse(localStorage.getItem(`${key}.size`) || ''); if (v.w > 0 && v.h > 0) return v } catch {  }
    return defSize
  })
  const moved = useRef(false)
  const save = (a: Anchor) => { try { localStorage.setItem(key, JSON.stringify(a)) } catch {  } }

  const fit = useCallback((a: Anchor, w: number, h: number): Anchor => ({
    right: Math.min(Math.max(8, a.right), Math.max(8, window.innerWidth - w - 8)),
    bottom: Math.min(Math.max(8, a.bottom), Math.max(8, window.innerHeight - h - 8)),
  }), [])

  const start = (e: React.PointerEvent, w: number, h: number) => {
    if (e.button !== 0) return
    const x0 = e.clientX, y0 = e.clientY, a0 = at
    moved.current = false
    let last = a0
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0, dy = ev.clientY - y0
      if (!moved.current && Math.hypot(dx, dy) < 4) return
      moved.current = true
      last = fit({ right: a0.right - dx, bottom: a0.bottom - dy }, w, h)
      setAt(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      if (moved.current) save(last)
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }

  const startResize = (e: React.PointerEvent, axes: 'x' | 'y' | 'xy' = 'xy') => {
    if (e.button !== 0) return
    e.preventDefault(); e.stopPropagation()
    const x0 = e.clientX, y0 = e.clientY, s0 = shown()
    let last = s0
    const move = (ev: PointerEvent) => {
      last = { w: axes === 'y' ? s0.w : Math.max(320, Math.min(s0.w - (ev.clientX - x0), window.innerWidth - 16)),
               h: axes === 'x' ? s0.h : Math.max(220, Math.min(s0.h - (ev.clientY - y0), window.innerHeight - 16)) }
      setSize(last)
    }
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
      try { localStorage.setItem(`${key}.size`, JSON.stringify(last)) } catch {  }
    }
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up)
  }
  const shown = (): Size => ({ w: Math.min(size.w, window.innerWidth - 16), h: Math.min(size.h, window.innerHeight - 16) })

  useEffect(() => {
    const onResize = () => setAt((a) => fit(a, 120, 52))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [fit])

  return { at, fit, start, dragged: () => moved.current, size: shown(), startResize }
}

export function ResizeGrip({ onPointerDown, dark }: { onPointerDown: (e: React.PointerEvent, axes: 'x' | 'y' | 'xy') => void; dark?: boolean }) {
  const hi = dark ? 'rgba(76,215,135,.45)' : 'rgba(50,121,133,.35)'
  const edge = (style: React.CSSProperties, axes: 'x' | 'y' | 'xy', cursor: string) => (
    <span onPointerDown={(e) => onPointerDown(e, axes)} title="drag to resize"
      onPointerEnter={(e) => { (e.currentTarget as HTMLElement).style.background = hi }}
      onPointerLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}
      style={{ position: 'absolute', zIndex: 20, touchAction: 'none', cursor, background: 'transparent', transition: 'background .12s', ...style }} />
  )
  return (
    <>
      {edge({ left: 0, top: 14, bottom: 0, width: 6 }, 'x', 'ew-resize')}
      {edge({ left: 14, right: 0, top: 0, height: 6 }, 'y', 'ns-resize')}
      {edge({ left: 0, top: 0, width: 14, height: 14 }, 'xy', 'nwse-resize')}
    </>
  )
}
