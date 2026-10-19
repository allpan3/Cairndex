import { replicaRequest } from './replicas'
import type { components } from './schema'

export type GroupingIntent = components['schemas']['GroupingCommand']['intent']
export type GroupingStatus = {
  id: string
  state: 'building' | 'editing' | 'ready'
  phase: string
  revision: number
  accepting: string | null
  error: string | null
  files: number
  selected: number
  bundles: number
  uncertain: number
  command: string | null
}
export type GroupingNode = {
  id: string
  parent: string | null
  kind: 'container' | 'bundle'
  title: string
  directory: string
  target: string | null
  original_target: string | null
  target_title: string | null
  collection: string | null
  context: boolean
  position: number
  confidence: number
  reason: string
  files: number
  selected: number
  bundles: number
  children: number
  folders: number
  media_counts?: Record<string, number>
}
export type GroupingFile = {
  id: string
  path: string
  role: string
  sequence: number
  selected: boolean
  media_kind: string
}
export type GroupingFolder = { path: string; expanded: boolean; files: number; selected: number }
export type GroupingStem = { directory: string; level: number; max: number; stem: string }
export type GroupingPage<T, C = number> = {
  items: T[]
  revision: number
  next_cursor: C | null
}
export type GroupingCommand = {
  id: string
  workspace: string
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'paused'
  phase: string
  error: string | null
  result: { revision?: number; candidate?: string; review?: string; verification?: string } | null
}
export type GroupingWorkspaces = {
  items: Pick<
    GroupingStatus,
    'id' | 'state' | 'phase' | 'revision' | 'files' | 'selected' | 'bundles' | 'accepting'
  >[]
  available_run: string | null
  next_cursor: number | null
}

export function grouping<T>(
  library: string,
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  return replicaRequest<T>(library, `/discovery/grouping${path}`, method, body, signal)
}
