// Minimal typed API client. Types are sourced from the backend's OpenAPI
// schema via `npm run gen:api` (see schema.d.ts), so the frontend and backend
// contracts cannot silently drift. The richer data layer (TanStack Query +
// per-endpoint hooks) arrives in Phase 3; for now a single hand-written fetch
// keeps the foundation lean (AGENTS.md §14).

import type { components } from './schema'

export type HealthStatus = components['schemas']['HealthStatus']

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetch('/api/v1/health', { signal })
  if (!response.ok) {
    throw new Error(`Backend health check failed (HTTP ${response.status})`)
  }
  return (await response.json()) as HealthStatus
}
