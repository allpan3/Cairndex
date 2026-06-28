// Typed API client. Request/response types come from the backend's OpenAPI
// schema (schema.d.ts, regenerated via `npm run gen:api`) so the frontend and
// backend contracts cannot silently drift.

import type { components } from './schema'

export type HealthStatus = components['schemas']['HealthStatus']
export type BundleSummary = components['schemas']['BundleSummary']
export type BundleBrowsePage = components['schemas']['BundleBrowsePage']
export type ViewCounts = components['schemas']['ViewCounts']
export type CollectionRead = components['schemas']['CollectionRead']
export type StorageRootRead = components['schemas']['StorageRootRead']
export type StorageRootCreate = components['schemas']['StorageRootCreate']
export type FileViewEntry = components['schemas']['FileViewEntryRead']
export type FileViewListing = components['schemas']['FileViewListingRead']
export type FileRead = components['schemas']['FileRead']
export type BundleRead = components['schemas']['BundleRead']
export type TagRead = components['schemas']['TagRead']
export type TagGroupRead = components['schemas']['TagGroupRead']
export type BundlePatch = components['schemas']['BundleUpdate']
export type FilePatch = components['schemas']['FileUpdate']
export type BatchUpdate = components['schemas']['BatchUpdate']

export type FilterExpression = components['schemas']['FilterExpression-Input']
export type SmartCollectionRead = components['schemas']['SmartCollectionRead']
export type SmartCollectionCreate = components['schemas']['SmartCollectionCreate']
export type SmartCollectionUpdate = components['schemas']['SmartCollectionUpdate']

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
    // Surface the server's structured `{message}` when present so callers can
    // show a friendly reason (e.g. "storage root is not currently available")
    // instead of a bare HTTP status.
    let detail = ''
    try {
      detail = ((await response.json()) as { message?: string }).message ?? ''
    } catch {
      /* non-JSON body */
    }
    throw new Error(detail || `Request failed (HTTP ${response.status}) for ${url}`)
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
  collectionId?: string | null
  includeDescendants?: boolean
  sort: BundleSort
  order: SortOrder
  offset: number
  limit: number
  filter?: FilterExpression | null
  // Scope to a single library (storage root). Null = unscoped (all roots).
  storageRootId?: string | null
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
      collection_id: params.collectionId ?? null,
      include_descendants: params.includeDescendants ?? false,
      sort: params.sort,
      order: params.order,
      offset: params.offset,
      limit: params.limit,
      filter: params.filter,
      storage_root_id: params.storageRootId ?? null,
    })
  }
  const q = new URLSearchParams({
    view: params.view,
    sort: params.sort,
    order: params.order,
    offset: String(params.offset),
    limit: String(params.limit),
  })
  if (params.collectionId) {
    q.set('collection_id', params.collectionId)
    q.set('include_descendants', String(params.includeDescendants ?? false))
  }
  if (params.storageRootId) q.set('storage_root_id', params.storageRootId)
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

// --- Smart Collections -------------------------------------------------------
export const fetchSmartCollections = (signal?: AbortSignal) =>
  getJson<SmartCollectionRead[]>('/api/v1/smart-collections', signal)

export const createSmartCollection = (payload: SmartCollectionCreate) =>
  send<SmartCollectionRead>('/api/v1/smart-collections', 'POST', payload)

export const updateSmartCollection = (id: string, payload: SmartCollectionUpdate) =>
  send<SmartCollectionRead>(`/api/v1/smart-collections/${id}`, 'PATCH', payload)

export const deleteSmartCollection = (id: string) =>
  send<void>(`/api/v1/smart-collections/${id}`, 'DELETE')

export const fetchPlaybackManifest = (bundleId: string, signal?: AbortSignal) =>
  getJson<PlaybackManifest>(`/api/v1/bundles/${bundleId}/playback`, signal)

export const previewEagleImport = (libraryPath: string) =>
  send<ImportPlanRead>('/api/v1/eagle/preview', 'POST', { library_path: libraryPath })

export const runEagleImport = (libraryPath: string) =>
  send<ImportResultRead>('/api/v1/eagle/import', 'POST', { library_path: libraryPath })

/** Append ?storage_root_id=… when a library scope is active. */
function rootQuery(rootId: string | null | undefined): string {
  return rootId ? `?storage_root_id=${encodeURIComponent(rootId)}` : ''
}

export function fetchViewCounts(rootId: string | null, signal?: AbortSignal): Promise<ViewCounts> {
  return getJson<ViewCounts>(`/api/v1/bundles/counts${rootQuery(rootId)}`, signal)
}

export function fetchCollectionCounts(
  rootId: string | null,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>(
    `/api/v1/collections/counts${rootQuery(rootId)}`,
    signal,
  ).then((r) => r.counts)
}

interface Page<T> {
  items: T[]
  next_cursor: string | null
}

export async function fetchAllCollections(signal?: AbortSignal): Promise<CollectionRead[]> {
  const collections: CollectionRead[] = []
  let cursor: string | null = null
  do {
    const url = `/api/v1/collections?limit=200${cursor ? `&cursor=${cursor}` : ''}`
    const page: Page<CollectionRead> = await getJson<Page<CollectionRead>>(url, signal)
    collections.push(...page.items)
    cursor = page.next_cursor
  } while (cursor)
  return collections
}

// --- Libraries (storage roots) -----------------------------------------------
export const fetchStorageRoots = (signal?: AbortSignal): Promise<StorageRootRead[]> =>
  fetchAllPaged<StorageRootRead>('/api/v1/storage-roots', signal)

export const createStorageRoot = (payload: StorageRootCreate) =>
  send<StorageRootRead>('/api/v1/storage-roots', 'POST', payload)

export const deleteStorageRoot = (id: string) => send<void>(`/api/v1/storage-roots/${id}`, 'DELETE')

export function fetchPathSuggestions(path: string, signal?: AbortSignal): Promise<string[]> {
  const q = `?path=${encodeURIComponent(path)}`
  return getJson<{ suggestions: string[] }>(
    `/api/v1/storage-roots/path-suggestions${q}`,
    signal,
  ).then((r) => r.suggestions)
}

// --- File View (read-only filesystem browsing) -------------------------------

export function fetchFileViewEntries(
  rootId: string,
  path: string | null,
  signal?: AbortSignal,
): Promise<FileViewListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return getJson<FileViewListing>(`/api/v1/storage-roots/${rootId}/entries${q}`, signal)
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

/** Raw bytes of a File View entry (storage root + relative path, read-only). */
export function fileViewContentUrl(rootId: string, path: string): string {
  return `/api/v1/storage-roots/${rootId}/file?path=${encodeURIComponent(path)}`
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

export function fetchTagCounts(
  rootId: string | null,
  signal?: AbortSignal,
): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>(
    `/api/v1/tags/counts${rootQuery(rootId)}`,
    signal,
  ).then((r) => r.counts)
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

export const setBundleCollections = (id: string, ids: string[]) =>
  send<unknown>(`/api/v1/bundles/${id}/collections`, 'PUT', { ids })

export const fetchBundleTags = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; tag_ids: string[] }>(`/api/v1/bundles/${id}/tags`, signal)

export const fetchBundleCollections = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; collection_ids: string[] }>(
    `/api/v1/bundles/${id}/collections`,
    signal,
  )

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
