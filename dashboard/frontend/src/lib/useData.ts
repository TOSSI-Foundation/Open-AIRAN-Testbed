import { createContext, useContext } from 'react'
import type { Collections } from './types'
import { MOCK } from './mockData'

export interface DataState {
  data: Collections
  loading: boolean
  source: 'backend' | 'mock'
}

export const DataContext = createContext<DataState>({
  data: MOCK,
  loading: true,
  source: 'mock',
})

export function useData(): DataState {
  return useContext(DataContext)
}

export function useCollection<K extends keyof Collections>(
  key: K,
): Collections[K] {
  const { data } = useData()
  const c = data[key]
  if (!c) {
    // eslint-disable-next-line no-console
    console.warn(`[TOSSI] unknown collection "${String(key)}"`)
    return [] as unknown as Collections[K]
  }
  return c
}
