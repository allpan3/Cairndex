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

export interface BrowseParams {
  view: SystemView
  folderId?: string | null
  includeDescendants?: boolean
  sort: BundleSort
  order: SortOrder
  offset: number
  limit: number
}

export function browseBundles(
  params: BrowseParams,
  signal?: AbortSignal,
): Promise<BundleBrowsePage> {
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

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  return getJson<HealthStatus>('/api/v1/health', signal)
}
