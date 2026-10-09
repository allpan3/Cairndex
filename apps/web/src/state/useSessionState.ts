import {
  useCallback,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react'

const values = new Map<string, unknown>()
const listeners = new Map<string, Set<() => void>>()
const LIMIT = 128

// Retain bounded navigation state for this window, reading a changed scope before rendering
export function useSessionState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [fallback] = useState(() => initial)
  const subscribe = useCallback(
    (listener: () => void) => {
      const group = listeners.get(key) ?? new Set()
      group.add(listener)
      listeners.set(key, group)
      return () => {
        group.delete(listener)
        if (!group.size) listeners.delete(key)
      }
    },
    [key],
  )
  const snapshot = useCallback(
    () => (values.has(key) ? (values.get(key) as T) : fallback),
    [key, fallback],
  )
  const value = useSyncExternalStore(subscribe, snapshot)
  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (update) => {
      const previous = values.has(key) ? (values.get(key) as T) : fallback
      const next = typeof update === 'function' ? (update as (value: T) => T)(previous) : update
      if (Object.is(previous, next)) return
      values.delete(key)
      values.set(key, next)
      for (const candidate of values.keys()) {
        if (values.size <= LIMIT) break
        if (!listeners.has(candidate)) values.delete(candidate)
      }
      listeners.get(key)?.forEach((listener) => listener())
    },
    [key, fallback],
  )
  return [value, set]
}
