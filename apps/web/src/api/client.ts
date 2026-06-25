// Minimal typed API client for Phase 0. The richer data layer (TanStack Query
// + a generated client) is introduced in Phase 3 alongside real endpoints;
// for now a single hand-written fetch keeps the foundation lean
// (AGENTS.md §14 — avoid speculative abstractions).

export interface HealthStatus {
  status: string
  app_name: string
  environment: string
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  const response = await fetch('/api/v1/health', { signal })
  if (!response.ok) {
    throw new Error(`Backend health check failed (HTTP ${response.status})`)
  }
  return (await response.json()) as HealthStatus
}
