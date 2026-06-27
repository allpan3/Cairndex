// Typed API client. Request/response types come from the backend's OpenAPI
// schema (schema.d.ts, regenerated via `npm run gen:api`) so the frontend and
// backend contracts cannot silently drift.

import type { components } from './schema'

export type HealthStatus = components['schemas']['HealthStatus']
export type BundleSummary = components['schemas']['BundleSummary']
export type BundleBrowsePage = components['schemas']['BundleBrowsePage']
export type ViewCounts = components['schemas']['ViewCounts']
export type FolderRead = components['schemas']['FolderRead']
export type FileRead = components['schemas']['FileRead']
export type BundleRead = components['schemas']['BundleRead']
export type TagRead = components['schemas']['TagRead']
export type TagGroupRead = components['schemas']['TagGroupRead']
export type BundlePatch = components['schemas']['BundleUpdate']
export type FilePatch = components['schemas']['FileUpdate']
export type BatchUpdate = components['schemas']['BatchUpdate']

export type FilterExpression = components['schemas']['FilterExpression-Input']
export type SmartFolderRead = components['schemas']['SmartFolderRead']
export type SmartFolderCreate = components['schemas']['SmartFolderCreate']
export type SmartFolderUpdate = components['schemas']['SmartFolderUpdate']

export type PlaybackManifest = components['schemas']['PlaybackManifest']
export type PlayableVideo = components['schemas']['PlayableVideo']
export type SubtitleTrackRead = components['schemas']['SubtitleTrackRead']

export type ImportPlanRead = components['schemas']['ImportPlanRead']
export type ImportResultRead = components['schemas']['ImportResultRead']

export type SystemView = 'all' | 'recent' | 'uncategorized' | 'untagged' | 'missing'
export type BundleSort = 'date_added' | 'title' | 'rating' | 'size' | 'file_count'
export type SortOrder = 'asc' | 'desc'

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}) for ${url}`)
  }
  return (await response.json()) as T
}

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { message?: string }).message ?? ''
    } catch {
      /* ignore */
    }
    throw new Error(`Request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
}

export interface BrowseParams {
  view: SystemView
  folderId?: string | null
  includeDescendants?: boolean
  sort: BundleSort
  order: SortOrder
  offset: number
  limit: number
  filter?: FilterExpression | null
}

export function browseBundles(
  params: BrowseParams,
  signal?: AbortSignal,
): Promise<BundleBrowsePage> {
  // A filter AST can't ride in a query string, so filtered browsing POSTs the
  // whole request; the unfiltered path stays a cacheable GET.
  if (params.filter) {
    return sendSignal<BundleBrowsePage>('/api/v1/bundles/browse', 'POST', signal, {
      view: params.view,
      folder_id: params.folderId ?? null,
      include_descendants: params.includeDescendants ?? false,
      sort: params.sort,
      order: params.order,
      offset: params.offset,
      limit: params.limit,
      filter: params.filter,
    })
  }
  const q = new URLSearchParams({
    view: params.view,
    sort: params.sort,
    order: params.order,
    offset: String(params.offset),
    limit: String(params.limit),
  })
  if (params.folderId) {
    q.set('folder_id', params.folderId)
    q.set('include_descendants', String(params.includeDescendants ?? false))
  }
  return getJson<BundleBrowsePage>(`/api/v1/bundles/browse?${q.toString()}`, signal)
}

async function sendSignal<T>(
  url: string,
  method: string,
  signal: AbortSignal | undefined,
  body: unknown,
): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new Error(`Request failed (HTTP ${response.status}) for ${url}`)
  }
  return (await response.json()) as T
}

export function previewFilter(filter: FilterExpression, signal?: AbortSignal): Promise<number> {
  return sendSignal<{ count: number }>('/api/v1/filters/preview', 'POST', signal, { filter }).then(
    (r) => r.count,
  )
}

// --- Smart Folders -----------------------------------------------------------
export const fetchSmartFolders = (signal?: AbortSignal) =>
  getJson<SmartFolderRead[]>('/api/v1/smart-folders', signal)

export const createSmartFolder = (payload: SmartFolderCreate) =>
  send<SmartFolderRead>('/api/v1/smart-folders', 'POST', payload)

export const updateSmartFolder = (id: string, payload: SmartFolderUpdate) =>
  send<SmartFolderRead>(`/api/v1/smart-folders/${id}`, 'PATCH', payload)

export const deleteSmartFolder = (id: string) => send<void>(`/api/v1/smart-folders/${id}`, 'DELETE')

export const fetchPlaybackManifest = (bundleId: string, signal?: AbortSignal) =>
  getJson<PlaybackManifest>(`/api/v1/bundles/${bundleId}/playback`, signal)

export const previewEagleImport = (libraryPath: string) =>
  send<ImportPlanRead>('/api/v1/eagle/preview', 'POST', { library_path: libraryPath })

export const runEagleImport = (libraryPath: string) =>
  send<ImportResultRead>('/api/v1/eagle/import', 'POST', { library_path: libraryPath })

export function fetchViewCounts(signal?: AbortSignal): Promise<ViewCounts> {
  return getJson<ViewCounts>('/api/v1/bundles/counts', signal)
}

export function fetchFolderCounts(signal?: AbortSignal): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>('/api/v1/folders/counts', signal).then(
    (r) => r.counts,
  )
}

interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export async function fetchAllFolders(signal?: AbortSignal): Promise<FolderRead[]> {
  const folders: FolderRead[] = []
  let cursor: string | null = null
  do {
    const url = `/api/v1/folders?limit=200${cursor ? `&cursor=${cursor}` : ''}`
    const page: Page<FolderRead> = await getJson<Page<FolderRead>>(url, signal)
    folders.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return folders
}

export function fetchBundle(id: string, signal?: AbortSignal): Promise<BundleRead> {
  return getJson<BundleRead>(`/api/v1/bundles/${id}`, signal)
}

export function fetchBundleFiles(id: string, signal?: AbortSignal): Promise<FileRead[]> {
  return getJson<FileRead[]>(`/api/v1/bundles/${id}/files`, signal)
}

export function thumbnailUrl(bundleId: string): string {
  return `/api/v1/bundles/${bundleId}/thumbnail`
}

export function fileThumbnailUrl(bundleId: string, fileId: string): string {
  return `/api/v1/bundles/${bundleId}/files/${fileId}/thumbnail`
}

export function fileContentUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/content`
}

export function fileStreamUrl(fileId: string): string {
  return `/api/v1/files/${fileId}/stream`
}

// --- Taxonomy (for the tag editor) ------------------------------------------
async function fetchAllPaged<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  do {
    const url = `${path}?limit=200${cursor ? `&cursor=${cursor}` : ''}`
    const page: Page<T> = await getJson<Page<T>>(url, signal)
    out.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return out
}

export const fetchTags = (signal?: AbortSignal) => fetchAllPaged<TagRead>('/api/v1/tags', signal)
export const fetchTagGroups = (signal?: AbortSignal) =>
  fetchAllPaged<TagGroupRead>('/api/v1/tag-groups', signal)

export function fetchTagCounts(signal?: AbortSignal): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>('/api/v1/tags/counts', signal).then(
    (r) => r.counts,
  )
}

export function fetchTagGroupTags(groupId: string, signal?: AbortSignal): Promise<string[]> {
  return getJson<{ group_id: string; tag_ids: string[] }>(
    `/api/v1/tag-groups/${groupId}/tags`,
    signal,
  ).then((r) => r.tag_ids)
}

// --- Mutations ---------------------------------------------------------------
export const updateBundle = (id: string, patch: BundlePatch) =>
  send<BundleRead>(`/api/v1/bundles/${id}`, 'PATCH', patch)

export const setBundleTags = (id: string, ids: string[]) =>
  send<unknown>(`/api/v1/bundles/${id}/tags`, 'PUT', { ids })

export const setBundleFolders = (id: string, ids: string[]) =>
  send<unknown>(`/api/v1/bundles/${id}/folders`, 'PUT', { ids })

export const fetchBundleTags = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; tag_ids: string[] }>(`/api/v1/bundles/${id}/tags`, signal)

export const fetchBundleFolders = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; folder_ids: string[] }>(`/api/v1/bundles/${id}/folders`, signal)

export const updateFile = (bundleId: string, fileId: string, patch: FilePatch) =>
  send<FileRead>(`/api/v1/bundles/${bundleId}/files/${fileId}`, 'PATCH', patch)

export const reorderFiles = (bundleId: string, orderedIds: string[]) =>
  send<FileRead[]>(`/api/v1/bundles/${bundleId}/files/order`, 'PUT', { ordered_ids: orderedIds })

export const removeFile = (bundleId: string, fileId: string) =>
  send<void>(`/api/v1/bundles/${bundleId}/files/${fileId}`, 'DELETE')

export const batchUpdate = (payload: BatchUpdate) =>
  send<{ updated: number }>('/api/v1/bundles/batch', 'POST', payload)

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  return getJson<HealthStatus>('/api/v1/health', signal)
}
