import { createContext, useContext } from 'react'
import type { Role } from './auth'

export interface AuthState {
  user: string
  role: Role
  onLogout: () => void
}

export const AuthContext = createContext<AuthState>({ user: '', role: 'viewer', onLogout: () => {} })

export const canChange = (r: Role) => r === 'admin' || r === 'operator'

export function useAuth(): AuthState {
  return useContext(AuthContext)
}
