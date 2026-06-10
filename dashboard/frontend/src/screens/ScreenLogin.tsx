import { heroGround } from '../styles/theme'
import { BrandMark } from '../components/ui'
import { useState } from 'react'
import { Icon } from '../components/Icon'
import { login } from '../lib/auth'

export function ScreenLogin({ onSuccess }: { onSuccess: (user: string) => void }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim()) {
      setError('Username required')
      return
    }
    setBusy(true)
    setError('')
    const res = await login(username.trim(), password)
    setBusy(false)
    if (res.ok && res.user) {
      onSuccess(res.user)
    } else {
      setError(res.error || 'Login failed')
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        fontFamily: "'Plus Jakarta Sans', sans-serif",
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: heroGround,
        }}
      />
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'transparent',
          backdropFilter: 'blur(2px)',
          WebkitBackdropFilter: 'blur(2px)',
        }}
      />

      <form
        onSubmit={submit}
        style={{
          position: 'relative',
          zIndex: 1,
          width: 380,
          maxWidth: '92vw',
          background: 'rgba(255,255,255,0.82)',
          backdropFilter: 'blur(18px) saturate(1.3)',
          WebkitBackdropFilter: 'blur(18px) saturate(1.3)',
          border: '1px solid rgba(255,255,255,0.7)',
          borderRadius: 20,
          padding: '34px 32px 30px',
          boxShadow: '0 24px 70px rgba(10,30,40,0.35)',
        }}
      >
        <div style={{ marginBottom: 24 }}>
          <BrandMark size={46} onDark={false} />
        </div>

        <div style={{ fontSize: 20, fontWeight: 800, color: '#133339', marginBottom: 20 }}>Sign in</div>

        <Field label="Username">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            style={inputStyle}
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </Field>

        {error && (
          <div
            style={{
              marginTop: 4,
              marginBottom: 12,
              fontSize: 13,
              fontWeight: 600,
              color: '#B3272C',
              background: '#FDECEC',
              border: '1px solid #F5C9CB',
              borderRadius: 10,
              padding: '9px 12px',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%',
            marginTop: 8,
            padding: '13px 0',
            border: 'none',
            borderRadius: 12,
            background: busy ? '#5AA8B6' : 'linear-gradient(150deg,#327985,#327985)',
            color: '#fff',
            fontSize: 15,
            fontWeight: 700,
            fontFamily: 'inherit',
            cursor: busy ? 'default' : 'pointer',
            boxShadow: '0 10px 24px rgba(18,160,181,.35)',
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '12px 14px',
  border: '1px solid #CBDFE2',
  borderRadius: 11,
  fontSize: 15,
  fontFamily: 'inherit',
  color: '#133339',
  background: 'rgba(255,255,255,0.9)',
  outline: 'none',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: '#3E5C64', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  )
}
