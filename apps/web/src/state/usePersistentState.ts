import { useCallback, useEffect, useState } from 'react'

/**
 * useState whose value is persisted to localStorage, so view preferences
 * (layout, zoom, sort) survive reloads (Phase 3 acceptance criterion).
 */
export function usePersistentState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // Ignore quota/availability errors — persistence is best-effort.
    }
  }, [key, value])

  const set = useCallback((next: T) => setValue(next), [])
  return [value, set]
}
