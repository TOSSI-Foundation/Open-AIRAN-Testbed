import { pageGround } from '../styles/theme'
import { useEffect, useRef, useState } from 'react'

const PHOTO_URL = '/hero-sky.jpg'
const TOPBAR_H = 0

const BLUR_RANGE = 520
const MAX_BLUR = 16
const MAX_DIM = 0.26

export function PageBackground({
  sidebarWidth = 260,
  mode = 'image',
}: {
  sidebarWidth?: number
  mode?: 'image' | 'sky'
}) {
  const [progress, setProgress] = useState(0)
  const raf = useRef<number | null>(null)

  useEffect(() => {
    const el = document.getElementById('sk-scroll')
    if (!el) return
    const onScroll = () => {
      if (raf.current != null) return
      raf.current = requestAnimationFrame(() => {
        raf.current = null
        setProgress(Math.min(1, Math.max(0, el.scrollTop / BLUR_RANGE)))
      })
    }
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      if (raf.current != null) cancelAnimationFrame(raf.current)
    }
  }, [])

  const blur = (progress * MAX_BLUR).toFixed(2)
  const isImage = mode === 'image'

  return (
    <>
      <div
        aria-hidden
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          pointerEvents: 'none',
          transition: 'background 0.3s ease',
          ...(isImage
            ? { background: '#F2F6F8' }
            : {
                background: pageGround,
              }),
        }}
      >
        {isImage && (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, aspectRatio: '1536 / 460', minHeight: 360,
                        backgroundImage: `url(${PHOTO_URL})`, backgroundSize: 'cover', backgroundPosition: 'center top',
                        maskImage: 'linear-gradient(180deg, #000 55%, transparent 100%)',
                        WebkitMaskImage: 'linear-gradient(180deg, #000 55%, transparent 100%)' }} />
        )}
        {isImage && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background:
                'linear-gradient(180deg, rgba(16,34,48,.16) 0%, rgba(16,34,48,.05) 30%, transparent 50%)',
            }}
          />
        )}
      </div>

      {isImage && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: TOPBAR_H,
            left: sidebarWidth,
            right: 0,
            bottom: 0,
            zIndex: 0,
            pointerEvents: 'none',
            backdropFilter: `blur(${blur}px) saturate(${(1 - progress * 0.15).toFixed(3)})`,
            WebkitBackdropFilter: `blur(${blur}px) saturate(${(1 - progress * 0.15).toFixed(3)})`,
            background: `rgba(238,243,244,${(progress * MAX_DIM).toFixed(3)})`,
            transition: 'backdrop-filter 90ms linear, background 90ms linear, left .22s cubic-bezier(.4,0,.2,1)',
          }}
        />
      )}
    </>
  )
}
