// Private Update progress and review intent never enter the authored catalog until accepted
import { replicaRequest } from './replicas'
import type { Save } from './catalog'

export type DiscoveryFile = {
  id?: string
  path: string
  generation: string
  evidence: { algorithm: string; size: number; digest: string }
  role?: string
}
export type DiscoveryCandidate = {
  id: string
  path: string
  body: {
    kind: 'new' | 'repair' | 'replacement'
    title: string
    target: string | null
    reason: string
    files: DiscoveryFile[]
    choices?: { file_id: string; path: string }[]
  }
}
export type DiscoveryRun = {
  id?: string
  state: 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  phase?: string
  observed?: number
  repaired?: number
  error?: string | null
}
export type DiscoveryReview = {
  id: string
  state: 'queued' | 'ready' | 'apply_queued' | 'applied' | 'failed' | 'cancelled'
  intent: { candidate: string; title?: string }
  prepared: { catalog: Save; files: DiscoveryFile[]; title: string; target: string | null } | null
  error: string | null
  receipt: string | null
  event: string | null
}

// The shared client fences responses to the active server and library
export function discovery<T>(
  library: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
) {
  return replicaRequest<T>(library, `/discovery${path}`, method, body, signal)
}
