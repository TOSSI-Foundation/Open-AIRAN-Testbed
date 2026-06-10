import { MOCK } from './mockData'
import type { Collections } from './types'
import { authHeader } from './auth'

const BASE = '/api'

async function getJSON<T>(path: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      headers: { Accept: 'application/json', ...authHeader() },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as T
  } catch {
    return fallback
  }
}

export const api = {
  async collections(): Promise<Collections> {
    return getJSON<Collections>('/collections', MOCK)
  },

  async me() {
    return getJSON('/me', {
      user: 'John Doe',
      role: 'Planner',
      tenant: 'TOSSI',
      tier: 'Enterprise',
      roles: ['admin'],
    })
  },

  async createRun(scenarioId: string, version: string) {
    return post('/runs', { scenario_id: scenarioId, version })
  },
  async startRun(runId: string) {
    return post(`/runs/${runId}/start`, {})
  },
  async stopRun(runId: string) {
    return post(`/runs/${runId}/stop`, {})
  },
  async importOsm(payload: unknown) {
    return post('/scenes/import/osm', payload)
  },
}

async function post(path: string, body: unknown) {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeader() },
      body: JSON.stringify(body),
    })
    return await res.json()
  } catch {
    return { ok: false, offline: true }
  }
}
