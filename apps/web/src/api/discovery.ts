// Private Update progress and review intent never enter the authored catalog until accepted
import { replicaRequest } from './replicas'
import type { Save } from './catalog'

export type DiscoveryFile = {
  id?: string
  path: string
  generation: string
  evidence: { algorithm: string; size: number; digest: string }
  role?: string
  position?: number
  group?: string
  accepted?: boolean
}
export type DiscoveryGroup = {
  id: string
  title: string
  target: string | null
  directory: string
  ancestors: { directory: string; title: string }[]
  folders: string[]
  placement?: string[]
  addition?: boolean
}
export type DiscoveryPage<T, C = number> = { items: T[]; next_cursor: C | null; total: number }
export type DiscoveryCandidate = {
  id: string
  path: string
  body: {
    version?: number
    kind: 'new' | 'collection' | 'repair' | 'replacement' | 'verification'
    title: string
    target: string | null
    reason: string
    files: DiscoveryFile[]
    file_count?: number
    files_next?: number | null
    unverified_count?: number
    choices?: { file_id: string; path: string }[]
    choices_total?: number
    choices_next?: string | null
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
export type DiscoveryVerification = {
  id: string
  candidate: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  error: string | null
  files: number
  verified: number
  bytes_read: number
  total_bytes: number
}
export type DiscoveryReview = {
  id: string
  state: 'queued' | 'ready' | 'apply_queued' | 'applied' | 'failed' | 'cancelled'
  intent: { candidate: string; title?: string }
  prepared: {
    version?: number
    catalog: Save & { change_count?: number; next_cursor?: number | null }
    files: DiscoveryFile[]
    file_count?: number
    group_count?: number
    files_next?: number | null
    groups?: DiscoveryGroup[]
    groups_next?: number | null
    title: string
    target: string | null
  } | null
  progress?: { phase: string; total: number; progress: number }
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
