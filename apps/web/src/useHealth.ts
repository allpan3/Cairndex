import { useEffect, useState } from 'react'
import { fetchHealth, type HealthStatus } from './api/client'

export type HealthState =
  { kind: 'loading' } | { kind: 'ok'; data: HealthStatus } | { kind: 'error'; message: string }

/**
 * Probe the backend health endpoint once on mount.
 *
 * This is intentionally a plain effect rather than TanStack Query: Phase 0 has
 * exactly one endpoint and no caching/refetch needs. The aborts guard against
 * setting state after unmount (React 18+ StrictMode double-invokes effects).
 */
export function useHealth(): HealthState {
  const [state, setState] = useState<HealthState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    fetchHealth(controller.signal)
      .then((data) => setState({ kind: 'ok', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        const message = error instanceof Error ? error.message : 'Unknown error'
        setState({ kind: 'error', message })
      })
    return () => controller.abort()
  }, [])

  return state
}
