// Typed API client. Request/response types come from the backend's OpenAPI
// schema (schema.d.ts, regenerated via `npm run gen:api`) so the frontend and
// backend contracts cannot silently drift.
//
// Content endpoints are scoped to one active library (ADR-0008). The active
// library id is module-global (one per browser tab); the UI sets it via
// `setActiveLibraryId` and routes content requests under
// `/api/v1/libraries/{id}/…`. Registry endpoints (libraries, jobs, health)
// stay global.

import type { components } from './schema'

export type HealthStatus = components['schemas']['HealthStatus']
export type BundleSummary = components['schemas']['BundleSummary']
export type BundleBrowsePage = components['schemas']['BundleBrowsePage']
export type ViewCounts = components['schemas']['ViewCounts']
export type CollectionRead = components['schemas']['CollectionRead']
export type LibraryRead = components['schemas']['LibraryRead']
export type LibraryCreate = components['schemas']['LibraryCreate']
export type LibraryRegister = components['schemas']['LibraryRegister']
export type JobRead = components['schemas']['JobRead']
export type AuthStatus = components['schemas']['AuthStatus']
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

export type SystemView = 'all' | 'recent' | 'uncategorized' | 'untagged' | 'missing'
export type BundleSort = 'date_added' | 'title' | 'rating' | 'size' | 'file_count'
export type SortOrder = 'asc' | 'desc'

// --- Active library (one per tab) --------------------------------------------
let activeLibraryId: string | null = null

export function setActiveLibraryId(id: string | null): void {
  activeLibraryId = id
}

export function getActiveLibraryId(): string | null {
  return activeLibraryId
}

/** Base path for content endpoints scoped to the active library. */
function lib(): string {
  if (!activeLibraryId) throw new Error('no active library selected')
  return `/api/v1/libraries/${activeLibraryId}`
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal })
  if (!response.ok) {
    // Surface the server's structured `{message}` when present so callers can
    // show a friendly reason (e.g. "library is currently unavailable") instead
    // of a bare HTTP status.
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

/**
 * Thrown on a 409 optimistic-concurrency conflict (ADR-0008 phase 9): the
 * `If-Match` version we sent was stale because another client edited the entity
 * first. Callers can detect this to refetch the latest and tell the user,
 * instead of silently overwriting the other edit.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

async function send<T>(
  url: string,
  method: string,
  body?: unknown,
  /** Optimistic-concurrency precondition: the entity `version` last read. */
  ifMatch?: number,
): Promise<T> {
  const headers: Record<string, string> = {}
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (ifMatch !== undefined) headers['If-Match'] = String(ifMatch)
  const response = await fetch(url, {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = ((await response.json()) as { message?: string }).message ?? ''
    } catch {
      /* ignore */
    }
    if (response.status === 409) {
      throw new ConflictError(detail || 'This item was changed elsewhere.')
    }
    throw new Error(`Request failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
  }
  return (response.status === 204 ? undefined : await response.json()) as T
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

export interface BrowseParams {
  view: SystemView
  collectionId?: string | null
  includeDescendants?: boolean
  sort: BundleSort
  order: SortOrder
  offset: number
  limit: number
  filter?: FilterExpression | null
  // Whole-library full-text search over metadata (title/filename/tag/etc.).
  search?: string | null
}

export function browseBundles(
  params: BrowseParams,
  signal?: AbortSignal,
): Promise<BundleBrowsePage> {
  const search = params.search?.trim() ? params.search.trim() : null
  // A filter AST can't ride in a query string, so filtered browsing POSTs the
  // whole request; the unfiltered path stays a cacheable GET.
  if (params.filter) {
    return sendSignal<BundleBrowsePage>(`${lib()}/bundles/browse`, 'POST', signal, {
      view: params.view,
      collection_id: params.collectionId ?? null,
      include_descendants: params.includeDescendants ?? false,
      sort: params.sort,
      order: params.order,
      offset: params.offset,
      limit: params.limit,
      filter: params.filter,
      q: search,
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
  if (search) q.set('q', search)
  return getJson<BundleBrowsePage>(`${lib()}/bundles/browse?${q.toString()}`, signal)
}

export function previewFilter(filter: FilterExpression, signal?: AbortSignal): Promise<number> {
  return sendSignal<{ count: number }>(`${lib()}/filters/preview`, 'POST', signal, { filter }).then(
    (r) => r.count,
  )
}

// --- Smart Collections -------------------------------------------------------
export const fetchSmartCollections = (signal?: AbortSignal) =>
  getJson<SmartCollectionRead[]>(`${lib()}/smart-collections`, signal)

export const createSmartCollection = (payload: SmartCollectionCreate) =>
  send<SmartCollectionRead>(`${lib()}/smart-collections`, 'POST', payload)

export const updateSmartCollection = (
  id: string,
  payload: SmartCollectionUpdate,
  version?: number,
) => send<SmartCollectionRead>(`${lib()}/smart-collections/${id}`, 'PATCH', payload, version)

export const deleteSmartCollection = (id: string) =>
  send<void>(`${lib()}/smart-collections/${id}`, 'DELETE')

export const fetchPlaybackManifest = (bundleId: string, signal?: AbortSignal) =>
  getJson<PlaybackManifest>(`${lib()}/bundles/${bundleId}/playback`, signal)

export function fetchViewCounts(signal?: AbortSignal): Promise<ViewCounts> {
  return getJson<ViewCounts>(`${lib()}/bundles/counts`, signal)
}

export function fetchCollectionCounts(signal?: AbortSignal): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>(`${lib()}/collections/counts`, signal).then(
    (r) => r.counts,
  )
}

interface Page<T> {
  items: T[]
  next_cursor: string | null
}

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

export const fetchAllCollections = (signal?: AbortSignal) =>
  fetchAllPaged<CollectionRead>(`${lib()}/collections`, signal)

// --- Libraries (registry) ----------------------------------------------------
export const fetchLibraries = (signal?: AbortSignal): Promise<LibraryRead[]> =>
  getJson<LibraryRead[]>('/api/v1/libraries', signal)

export const createLibrary = (payload: LibraryCreate) =>
  send<LibraryRead>('/api/v1/libraries/create', 'POST', payload)

export const registerLibrary = (payload: LibraryRegister) =>
  send<LibraryRead>('/api/v1/libraries/register', 'POST', payload)

export function fetchPathSuggestions(path: string, signal?: AbortSignal): Promise<string[]> {
  const q = `?path=${encodeURIComponent(path)}`
  return getJson<{ suggestions: string[] }>(`/api/v1/libraries/path-suggestions${q}`, signal).then(
    (r) => r.suggestions,
  )
}

// --- Background jobs ----------------------------------------------------------
export const enqueueScan = () => send<JobRead>(`${lib()}/jobs/scan`, 'POST')

export const enqueueProbe = () => send<JobRead>(`${lib()}/jobs/probe`, 'POST')

export const enqueueThumbnails = () => send<JobRead>(`${lib()}/jobs/thumbnails`, 'POST')

/** Fetch the current status/result for a background job. */
export const fetchJob = (id: string, signal?: AbortSignal) =>
  getJson<JobRead>(`/api/v1/jobs/${id}`, signal)

// --- Per-library passphrase lock (ADR-0010) ----------------------------------
export const fetchAuthStatus = (libraryId: string, signal?: AbortSignal) =>
  getJson<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/status`, signal)

export const unlockLibrary = (libraryId: string, passphrase: string) =>
  send<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/unlock`, 'POST', { passphrase })

export const lockLibrary = (libraryId: string) =>
  send<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/lock`, 'POST')

// --- Grouping plans (ADR-0009) ------------------------------------------------
export type GroupingPlan = components['schemas']['PlanRead']
export type GroupingProposal = components['schemas']['ProposalRead']
export type GroupingProposalFile = components['schemas']['ProposalFileRead']
export type GroupingPlanSummary = components['schemas']['PlanSummary']
export type GroupingApplyResult = components['schemas']['ApplyResultRead']

/** Suggest a grouping for the active library and store it as the open plan. */
export const generateGroupingPlan = () => send<GroupingPlan>(`${lib()}/grouping/plans`, 'POST')

export const fetchGroupingPlans = (signal?: AbortSignal): Promise<GroupingPlanSummary[]> =>
  getJson<GroupingPlanSummary[]>(`${lib()}/grouping/plans`, signal)

export const fetchGroupingPlan = (id: string, signal?: AbortSignal): Promise<GroupingPlan> =>
  getJson<GroupingPlan>(`${lib()}/grouping/plans/${id}`, signal)

/** Apply selected plan proposals: confirm bundles, create collections, link subtitles. */
export const applyGroupingPlan = (
  id: string,
  proposalIds?: string[],
): Promise<GroupingApplyResult> =>
  send<GroupingApplyResult>(
    `${lib()}/grouping/plans/${id}/apply`,
    'POST',
    proposalIds ? { proposal_ids: proposalIds } : undefined,
  )

// --- File View (read-only filesystem browsing) -------------------------------
export function fetchFileViewEntries(
  path: string | null,
  signal?: AbortSignal,
): Promise<FileViewListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return getJson<FileViewListing>(`${lib()}/file-view/entries${q}`, signal)
}

export function fetchBundle(id: string, signal?: AbortSignal): Promise<BundleRead> {
  return getJson<BundleRead>(`${lib()}/bundles/${id}`, signal)
}

export function fetchBundleFiles(id: string, signal?: AbortSignal): Promise<FileRead[]> {
  return getJson<FileRead[]>(`${lib()}/bundles/${id}/files`, signal)
}

export function thumbnailUrl(bundleId: string): string {
  return `${lib()}/bundles/${bundleId}/thumbnail`
}

export function fileThumbnailUrl(bundleId: string, fileId: string): string {
  return `${lib()}/bundles/${bundleId}/files/${fileId}/thumbnail`
}

export function fileContentUrl(fileId: string): string {
  return `${lib()}/files/${fileId}/content`
}

/** Raw bytes of a File View entry (library-relative path, read-only). */
export function fileViewContentUrl(path: string): string {
  return `${lib()}/file?path=${encodeURIComponent(path)}`
}

export function fileStreamUrl(fileId: string): string {
  return `${lib()}/files/${fileId}/stream`
}

// --- Taxonomy (for the tag editor) ------------------------------------------
export const fetchTags = (signal?: AbortSignal) => fetchAllPaged<TagRead>(`${lib()}/tags`, signal)
export const fetchTagGroups = (signal?: AbortSignal) =>
  fetchAllPaged<TagGroupRead>(`${lib()}/tag-groups`, signal)

export function fetchTagCounts(signal?: AbortSignal): Promise<Record<string, number>> {
  return getJson<{ counts: Record<string, number> }>(`${lib()}/tags/counts`, signal).then(
    (r) => r.counts,
  )
}

export function fetchTagGroupTags(groupId: string, signal?: AbortSignal): Promise<string[]> {
  return getJson<{ group_id: string; tag_ids: string[] }>(
    `${lib()}/tag-groups/${groupId}/tags`,
    signal,
  ).then((r) => r.tag_ids)
}

// --- Mutations ---------------------------------------------------------------
export const updateBundle = (id: string, patch: BundlePatch, version?: number) =>
  send<BundleRead>(`${lib()}/bundles/${id}`, 'PATCH', patch, version)

export const setBundleTags = (id: string, ids: string[]) =>
  send<unknown>(`${lib()}/bundles/${id}/tags`, 'PUT', { ids })

export const setBundleCollections = (id: string, ids: string[]) =>
  send<unknown>(`${lib()}/bundles/${id}/collections`, 'PUT', { ids })

export const fetchBundleTags = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; tag_ids: string[] }>(`${lib()}/bundles/${id}/tags`, signal)

export const fetchBundleCollections = (id: string, signal?: AbortSignal) =>
  getJson<{ bundle_id: string; collection_ids: string[] }>(
    `${lib()}/bundles/${id}/collections`,
    signal,
  )

export const updateFile = (bundleId: string, fileId: string, patch: FilePatch, version?: number) =>
  send<FileRead>(`${lib()}/bundles/${bundleId}/files/${fileId}`, 'PATCH', patch, version)

export const reorderFiles = (bundleId: string, orderedIds: string[]) =>
  send<FileRead[]>(`${lib()}/bundles/${bundleId}/files/order`, 'PUT', { ordered_ids: orderedIds })

export const removeFile = (bundleId: string, fileId: string) =>
  send<void>(`${lib()}/bundles/${bundleId}/files/${fileId}`, 'DELETE')

export const batchUpdate = (payload: BatchUpdate) =>
  send<{ updated: number }>(`${lib()}/bundles/batch`, 'POST', payload)

// Removal is metadata-only on both endpoints: the bundle's/collection's rows are
// deleted but no file on disk is ever touched (AGENTS.md §3, §10). Deleting a
// collection floats its children to the root and drops bundle memberships; the
// bundles themselves are not deleted.
export const deleteBundle = (id: string) => send<void>(`${lib()}/bundles/${id}`, 'DELETE')

// `cascade` also removes the collection's descendant subcollections; otherwise
// they float to the library root. Bundles and files are kept either way.
export const deleteCollection = (id: string, cascade = false) =>
  send<void>(`${lib()}/collections/${id}?cascade=${cascade}`, 'DELETE')

export async function fetchHealth(signal?: AbortSignal): Promise<HealthStatus> {
  return getJson<HealthStatus>('/api/v1/health', signal)
}
