const TOKEN_KEY = 'tossi.token'
const USER_KEY = 'tossi.user'

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getStoredUser(): string | null {
  return localStorage.getItem(USER_KEY)
}

export function authHeader(): Record<string, string> {
  const t = getToken()
  return t ? { Authorization: `Bearer ${t}` } : {}
}

export interface LoginResult {
  ok: boolean
  user?: string
  error?: string
}

export async function login(username: string, password: string): Promise<LoginResult> {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) {
      return { ok: false, error: data.error || `Login failed (HTTP ${res.status}).` }
    }
    localStorage.setItem(TOKEN_KEY, data.token)
    localStorage.setItem(USER_KEY, data.user)
    return { ok: true, user: data.user }
  } catch {
    return { ok: false, error: 'Cannot reach the server. Is the backend running?' }
  }
}

export async function logout(): Promise<void> {
  try {
    await fetch('/api/logout', { method: 'POST', headers: authHeader() })
  } catch {
  }
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(ROLE_KEY)
}

export type Role = 'admin' | 'operator' | 'viewer'
const ROLE_KEY = 'tossi.role'

export async function fetchMe(): Promise<{ user: string; role: Role } | null> {
  const t = getToken()
  if (!t) return null
  try {
    const res = await fetch('/api/me', { headers: authHeader() })
    if (!res.ok) return null
    const data = await res.json()
    if (data.user) {
      localStorage.setItem(USER_KEY, data.user)
      localStorage.setItem(ROLE_KEY, data.role)
      return { user: data.user, role: data.role }
    }
    return null
  } catch {
    const u = getStoredUser()
    return u ? { user: u, role: (localStorage.getItem(ROLE_KEY) as Role) || 'viewer' } : null
  }
}
