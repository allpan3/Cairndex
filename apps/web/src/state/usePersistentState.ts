import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * useState whose value is persisted to localStorage, so view preferences
 * (layout, zoom, sort) survive reloads (Phase 3 acceptance criterion).
 */
export function usePersistentState<T>(
  key: string,
  initial: T,
  options: { debounceMs?: number } = {},
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw !== null ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })

  useEffect(() => {
    const persist = () => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Ignore quota/availability errors — persistence is best-effort
      }
    }
    if (!options.debounceMs) {
      persist()
      return
    }
    const timeout = window.setTimeout(persist, options.debounceMs)
    return () => window.clearTimeout(timeout)
  }, [key, options.debounceMs, value])

  useEffect(() => {
    if (!options.debounceMs) return
    const persist = () => {
      try {
        localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Ignore quota/availability errors — persistence is best-effort
      }
    }
    window.addEventListener('pointerup', persist)
    window.addEventListener('pagehide', persist)
    window.addEventListener('beforeunload', persist)
    return () => {
      window.removeEventListener('pointerup', persist)
      window.removeEventListener('pagehide', persist)
      window.removeEventListener('beforeunload', persist)
    }
  }, [key, options.debounceMs, value])

  const set = useCallback<Dispatch<SetStateAction<T>>>((next) => {
    setValue(next)
  }, [])
  return [value, set]
}
