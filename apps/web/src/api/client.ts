// Typed API client. Request/response types come from the backend's OpenAPI
// schema (schema.d.ts, regenerated via `npm run gen:api`) so the frontend and
// backend contracts cannot silently drift.
//
// Content endpoints are scoped to one active library (ADR-0008). The active
// library id is module-global (one per browser tab); the UI sets it via
// `setActiveLibraryId` and routes content requests under
// `/api/v1/libraries/{id}/…`. Registry endpoints (libraries, jobs, health)
// stay global.

import { hostFetch, resolveHostAssetUrl } from '../platform'
import type { components } from './schema'

export type HealthStatus = components['schemas']['HealthStatus']
export type BundleSummary = components['schemas']['BundleSummary']
export type BundleBrowsePage = components['schemas']['BundleBrowsePage']
export type ViewCounts = components['schemas']['ViewCounts']
export type CollectionRead = components['schemas']['CollectionRead']
export type CollectionCreate = components['schemas']['CollectionCreate']
export type CollectionStats = components['schemas']['CollectionStats']
export type LibraryRead = components['schemas']['LibraryRead']
export type LibraryCreate = components['schemas']['LibraryCreate']
export type LibraryRegister = components['schemas']['LibraryRegister']
export type PathSuggestion = components['schemas']['PathSuggestion']
export type PathSuggestions = components['schemas']['PathSuggestions']
export type PathProbe = components['schemas']['PathProbeRead']
export type WriteModeRead = components['schemas']['WriteModeRead']
export type FileOperationRead = components['schemas']['FileOperationRead']
export type FileOperationResult = components['schemas']['FileOperationResult']
export type ConflictPolicy = components['schemas']['ConflictPolicy']
export type TrashRead = components['schemas']['TrashRead']
export type TrashedOperation = components['schemas']['TrashedOperationRead']
export type EmptyTrashResult = components['schemas']['EmptyTrashResult']
export type ImportResult = components['schemas']['ImportResultRead']
export type JobRead = components['schemas']['JobRead']
export type AuthStatus = components['schemas']['AuthStatus']
export type DeviceRead = components['schemas']['DeviceRead']
export type PairStartResponse = components['schemas']['PairStartResponse']
export type PairPollResponse = components['schemas']['PairPollResponse']
export type FileBrowserEntry = components['schemas']['FileBrowserEntryRead']
export type FileBrowserListing = components['schemas']['FileBrowserListingRead']
export type FileRead = components['schemas']['FileRead']
export type FileRepairCandidate = components['schemas']['FileRepairCandidateRead']
export type BundleRead = components['schemas']['BundleRead']
export type BundleCursorRead = components['schemas']['BundleCursorRead']
export type TagRead = components['schemas']['TagRead']
export type TagCreate = components['schemas']['TagCreate']
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
export type PlaybackProgressRead = components['schemas']['PlaybackProgressRead']
export type PlaybackProgressUpdate = components['schemas']['PlaybackProgressUpdate']
export type ContinueWatchingProgressRead = components['schemas']['ContinueWatchingProgressRead']
export type ContinueWatchingItem = components['schemas']['ContinueWatchingItem']
export type ContinueWatchingPage = components['schemas']['ContinueWatchingPage']
export type SubtitleTrackRead = components['schemas']['SubtitleTrackRead']
export type AudioStreamRead = components['schemas']['AudioStreamRead']
export type ClientCapabilities = components['schemas']['ClientCapabilities']
export type PlaybackDecisionRequest = components['schemas']['PlaybackDecisionRequest']
export type PlaybackDecisionResponse = components['schemas']['PlaybackDecisionResponse']

export type SystemView =
  | 'all'
  | 'recent'
  | 'uncategorized'
  | 'untagged'
  | 'missing'
  | 'unbundled'
  | 'random'
export type BundleSort =
  | 'date_added'
  | 'date_modified'
  | 'date_opened'
  | 'title'
  | 'rating'
  | 'size'
  | 'file_count'
  | 'manual'
// The real (non-manual) sorts a "Clean up by…" can rewrite the manual order to.
export type CleanupSort = Exclude<BundleSort, 'manual'>
export type SortOrder = 'asc' | 'desc'

const STORYBOARD_INDEX_CACHE_VERSION = 'sb2'

// --- Manual bundling assistant (Unbundled staging follow-up to ADR-0009) ------
export type TargetSuggestion = components['schemas']['TargetSuggestionRead']
export type FileSuggestion = components['schemas']['FileSuggestionRead']
export type ProposedRole = components['schemas']['ProposedRoleRead']
export type BundleDraft = components['schemas']['BundleDraftResponse']
export type ManualBundleResult = components['schemas']['ManualBundleResultRead']

// --- Active library (one per tab) --------------------------------------------
let activeLibraryId: string | null = null

type CairndexRuntime = typeof globalThis & {
  __cairndexApiBaseUrl?: string | null
}

// Survives Vite module replacement while a desktop connection remains active
const runtime = globalThis as CairndexRuntime

// Selects the remote server used by the desktop host while browsers stay same-origin
export function setApiBaseUrl(value: string | null): void {
  runtime.__cairndexApiBaseUrl = value ? value.trim().replace(/\/+$/, '') : null
}

// Resolves API and media paths without rewriting already absolute URLs
export function resolveApiUrl(value: string): string {
  const apiBaseUrl = runtime.__cairndexApiBaseUrl
  if (!apiBaseUrl || /^[a-z][a-z\d+.-]*:/i.test(value)) return value
  return `${apiBaseUrl}/${value.replace(/^\/+/, '')}`
}

// Resolves server-owned media through the desktop bearer relay when active
export function resolveAssetUrl(value: string): string {
  return resolveHostAssetUrl(resolveApiUrl(value))
}

export function setActiveLibraryId(id: string | null): void {
  activeLibraryId = id
}

export function getActiveLibraryId(): string | null {
  return activeLibraryId
}

/** Base path for content endpoints scoped to an explicit or active library */
function lib(libraryId: string | null = activeLibraryId): string {
  if (!libraryId) throw new Error('no active library selected')
  return `/api/v1/libraries/${libraryId}`
}

/** Extract a useful message from structured API and FastAPI validation errors. */
function apiErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const error = payload as {
    message?: unknown
    detail?: unknown
  }
  if (typeof error.message === 'string') return error.message
  if (typeof error.detail === 'string') return error.detail
  if (Array.isArray(error.detail)) {
    return error.detail
      .map((item) =>
        item && typeof item === 'object' && typeof (item as { msg?: unknown }).msg === 'string'
          ? (item as { msg: string }).msg
          : '',
      )
      .filter(Boolean)
      .join('; ')
  }
  return ''
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const resolvedUrl = resolveApiUrl(url)
  const response = await hostFetch(resolvedUrl, { signal })
  if (!response.ok) {
    // Surface the server's structured `{message}` when present so callers can
    // show a friendly reason (e.g. "library is currently unavailable") instead
    // of a bare HTTP status.
    let detail = ''
    try {
      detail = apiErrorDetail(await response.json())
    } catch {
      /* non-JSON body */
    }
    throw new Error(detail || `Request failed (HTTP ${response.status}) for ${resolvedUrl}`)
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
  const response = await hostFetch(resolveApiUrl(url), {
    method,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = apiErrorDetail(await response.json())
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
  const resolvedUrl = resolveApiUrl(url)
  const response = await hostFetch(resolvedUrl, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) {
    throw new HttpError(
      response.status,
      `Request failed (HTTP ${response.status}) for ${resolvedUrl}`,
    )
  }
  return (await response.json()) as T
}

/** Carries the HTTP status so callers can branch (e.g. retry a 429). */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
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
  // Shuffle seed for the Random view; a new seed is a reshuffle.
  seed?: number | null
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
      seed: params.seed ?? null,
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
  if (params.seed != null) q.set('seed', String(params.seed))
  return getJson<BundleBrowsePage>(`${lib()}/bundles/browse?${q.toString()}`, signal)
}

export function previewFilter(filter: FilterExpression, signal?: AbortSignal): Promise<number> {
  return sendSignal<{ count: number }>(`${lib()}/filters/preview`, 'POST', signal, { filter }).then(
    (r) => r.count,
  )
}

// --- Faceted counts (toolbar filter popovers) --------------------------------
export type FacetResponse = components['schemas']['FacetResponse']

export interface FacetParams {
  view: SystemView
  collectionId?: string | null
  includeDescendants?: boolean
  q?: string | null
  // Base filter for the *other* active categories (must exclude the category
  // whose facet counts are being shown).
  filter?: FilterExpression | null
  facets: string[]
  // Whether parent-tag counts roll up descendants (Any/All) or stay direct (Equal).
  tagIncludeDescendants?: boolean
}

export function fetchFacets(params: FacetParams, signal?: AbortSignal): Promise<FacetResponse> {
  return sendSignal<FacetResponse>(`${lib()}/filters/facets`, 'POST', signal, {
    view: params.view,
    collection_id: params.collectionId ?? null,
    include_descendants: params.includeDescendants ?? false,
    q: params.q?.trim() || null,
    filter: params.filter ?? null,
    facets: params.facets,
    tag_include_descendants: params.tagIncludeDescendants ?? true,
  })
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

// Resolves every media URL embedded in a playback manifest for the desktop host
function resolvePlaybackManifest(manifest: PlaybackManifest): PlaybackManifest {
  return {
    ...manifest,
    videos: manifest.videos.map((video) => ({
      ...video,
      stream_url: resolveAssetUrl(video.stream_url),
      storyboard_url: video.storyboard_url ? resolveAssetUrl(video.storyboard_url) : null,
      subtitles: video.subtitles.map((track) => ({
        ...track,
        src: track.src ? resolveAssetUrl(track.src) : null,
      })),
    })),
  }
}

export const fetchPlaybackManifest = (bundleId: string, signal?: AbortSignal) =>
  getJson<PlaybackManifest>(`${lib()}/bundles/${bundleId}/playback`, signal).then(
    resolvePlaybackManifest,
  )

// --- Playback decisions + HLS sessions (plan 1 §6.3, M7) ---------------------
// Ask the server how to play one file for this client's capabilities. A direct
// decision returns a progressive `stream_url`; remux/transcode returns a started
// HLS `session` whose playlist the player feeds to hls.js or native HLS.
export const requestPlaybackDecision = (
  fileId: string,
  payload: PlaybackDecisionRequest,
  signal?: AbortSignal,
) =>
  sendSignal<PlaybackDecisionResponse>(
    `${lib()}/files/${fileId}/playback-decision`,
    'POST',
    signal,
    payload,
  ).then((decision) => ({
    ...decision,
    stream_url: decision.stream_url ? resolveAssetUrl(decision.stream_url) : null,
    storyboard_url: decision.storyboard_url ? resolveAssetUrl(decision.storyboard_url) : null,
    session: decision.session
      ? { ...decision.session, playlist_url: resolveAssetUrl(decision.session.playlist_url) }
      : null,
    subtitles: decision.subtitles.map((track) => ({
      ...track,
      src: track.src ? resolveAssetUrl(track.src) : null,
    })),
  }))

/** Tear down an HLS session (player close, file switch, quality/audio switch). */
export const deletePlaybackSession = (fileId: string, sessionId: string) =>
  send<void>(`${lib()}/files/${fileId}/playback-sessions/${sessionId}`, 'DELETE')

/**
 * Fire a best-effort `pagehide` POST via `navigator.sendBeacon`. A JSON `body`
 * is sent when given; with no body the beacon is a bare POST (CORS-safelisted).
 */
function beacon(url: string, body?: unknown): boolean {
  if (!navigator.sendBeacon) return false
  const resolvedUrl = resolveAssetUrl(url)
  if (body === undefined) return navigator.sendBeacon(resolvedUrl)
  const blob = new Blob([JSON.stringify(body)], { type: 'application/json' })
  return navigator.sendBeacon(resolvedUrl, blob)
}

/** Best-effort browser teardown on pagehide via sendBeacon's POST-only transport. */
export function beaconTeardownSession(fileId: string, sessionId: string): boolean {
  // The teardown alias takes no body — a bodyless beacon keeps it CORS-safelisted.
  return beacon(`${lib()}/files/${fileId}/playback-sessions/${sessionId}/teardown`)
}

export const fetchContinueWatching = (limit = 20, offset = 0, signal?: AbortSignal) =>
  getJson<ContinueWatchingPage>(
    `${lib()}/continue-watching?limit=${limit}&offset=${offset}`,
    signal,
  )

export const updatePlaybackProgress = (fileId: string, payload: PlaybackProgressUpdate) =>
  send<PlaybackProgressRead>(`${lib()}/files/${fileId}/progress`, 'PUT', payload)

export function beaconPlaybackProgress(fileId: string, payload: PlaybackProgressUpdate): boolean {
  return beacon(`${lib()}/files/${fileId}/progress`, payload)
}

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

export const createCollection = (payload: CollectionCreate) =>
  send<CollectionRead>(`${lib()}/collections`, 'POST', payload)

export const renameCollection = (id: string, name: string, version?: number) =>
  send<CollectionRead>(`${lib()}/collections/${id}`, 'PATCH', { name }, version)

export const updateCollection = (
  id: string,
  patch: {
    name?: string
    note?: string | null
    cover_bundle_id?: string | null
    // Reparent (drag a collection into another; null = move to top level).
    parent_id?: string | null
  },
  version?: number,
) => send<CollectionRead>(`${lib()}/collections/${id}`, 'PATCH', patch, version)

export const fetchCollectionStats = (id: string, signal?: AbortSignal) =>
  getJson<CollectionStats>(`${lib()}/collections/${id}/stats`, signal)

// Persist a manual drag-reorder of one sibling group (parentId null = top level).
// The sidebar tree and main-browser folder cards share this sort_order.
export const reorderCollections = (
  parentId: string | null,
  movedIds: string[],
  beforeId: string | null,
) =>
  send<CollectionRead[]>(`${lib()}/collections/reorder`, 'PUT', {
    parent_id: parentId,
    moved_ids: movedIds,
    before_id: beforeId,
  })

// "Clean up by… Title": rewrite every sibling group's manual order alphabetically.
export const cleanupCollectionOrder = (order: 'asc' | 'desc') =>
  send<void>(`${lib()}/collections/cleanup-order`, 'POST', { order })

// --- Libraries (registry) ----------------------------------------------------
export const fetchLibraries = (signal?: AbortSignal): Promise<LibraryRead[]> =>
  getJson<LibraryRead[]>('/api/v1/libraries', signal)

export const createLibrary = (payload: LibraryCreate) =>
  send<LibraryRead>('/api/v1/libraries/create', 'POST', payload)

export const registerLibrary = (payload: LibraryRegister) =>
  send<LibraryRead>('/api/v1/libraries/register', 'POST', payload)

/**
 * Deregister a library. **Metadata-only** — the folder, its `.cairndex/`
 * package, and every media file are left untouched, so adding it back later
 * restores the library with all of its metadata.
 */
export const deleteLibrary = (libraryId: string) =>
  send<void>(`/api/v1/libraries/${libraryId}`, 'DELETE')

export function fetchPathSuggestions(
  path: string,
  signal?: AbortSignal,
): Promise<PathSuggestion[]> {
  const q = `?path=${encodeURIComponent(path)}`
  return getJson<PathSuggestions>(`/api/v1/libraries/path-suggestions${q}`, signal).then(
    (r) => r.suggestions,
  )
}

/** What a candidate path is, so the add flow can confirm the right action. */
export const probeLibraryPath = (path: string, signal?: AbortSignal) =>
  getJson<PathProbe>(`/api/v1/libraries/probe-path?path=${encodeURIComponent(path)}`, signal)

// --- Guarded file operations (ADR-0013 W1) -----------------------------------
/**
 * Thrown when a write operation's destination is already taken.
 *
 * Its own class because a collision is a *question*, not a failure: the caller
 * shows Skip / Keep both and re-issues with an explicit policy. `name` is what
 * the dialog needs to name the thing in the way.
 */
export class PathConflictError extends Error {
  // Not `name`: that is `Error`'s own field, and this is the *entry's* name.
  entryName: string
  path: string

  constructor(message: string, entryName: string, path: string) {
    super(message)
    this.name = 'PathConflictError'
    this.entryName = entryName
    this.path = path
  }
}

async function sendFileOp<T>(url: string, body: unknown): Promise<T> {
  const response = await hostFetch(resolveApiUrl(url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* non-JSON body */
    }
    const detail = apiErrorDetail(payload)
    const details = (payload as { details?: { code?: string; name?: string; path?: string } })
      ?.details
    if (response.status === 409 && details?.code === 'path_conflict') {
      throw new PathConflictError(detail, details.name ?? '', details.path ?? '')
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  return (await response.json()) as T
}

/** Rename one file or directory in place, carrying its metadata with it. */
export const renameEntry = (path: string, newName: string, onConflict?: ConflictPolicy) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/rename`, {
    path,
    new_name: newName,
    on_conflict: onConflict ?? 'fail',
  })

/** Create one new directory; its parent must already exist. */
export const makeDirectory = (path: string) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/mkdir`, { path })

/** Apply an operation's inverse — the Undo behind a completed toast. */
export const undoFileOperation = (operationId: string) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/${operationId}/undo`, {})

/**
 * Stream one external file into the library (ADR-0013 §7).
 *
 * The `File`/`Blob` is the request body — no multipart, no base64, no copy in
 * memory: the browser streams it straight off disk. Metadata rides in the query
 * string because the body is spoken for.
 */
export async function importFile(
  file: File,
  options: {
    destDir?: string
    filename?: string
    onConflict?: ConflictPolicy
    link?: boolean
    signal?: AbortSignal
  } = {},
): Promise<ImportResult> {
  const query = new URLSearchParams({
    dest_dir: options.destDir ?? '',
    filename: options.filename ?? file.name,
    on_conflict: options.onConflict ?? 'fail',
    // Default off: importing copies the file in without fast-adding it to a
    // bundle. Callers opt in explicitly if they ever want the link.
    link: String(options.link ?? false),
  })
  const response = await hostFetch(resolveApiUrl(`${lib()}/file-ops/import?${query}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal: options.signal,
  })
  if (!response.ok) {
    let payload: unknown = null
    try {
      payload = await response.json()
    } catch {
      /* non-JSON body */
    }
    const detail = apiErrorDetail(payload)
    const details = (payload as { details?: { code?: string; name?: string; path?: string } })
      ?.details
    if (response.status === 409 && details?.code === 'path_conflict') {
      throw new PathConflictError(detail, details.name ?? file.name, details.path ?? '')
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  return (await response.json()) as ImportResult
}

/** Move files and folders into the library's trash. Never unlinks. */
export const trashEntries = (paths: string[]) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/trash`, { paths })

/**
 * Move files and folders into another directory, carrying their metadata.
 *
 * The whole selection is one operation with one undo. A collision answers 409
 * `path_conflict` before anything moves, which the caller turns into the
 * Replace / Skip / Keep both prompt and re-issues with an explicit policy.
 */
export const moveEntries = (paths: string[], destDir: string, onConflict?: ConflictPolicy) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/move`, {
    paths,
    dest_dir: destDir,
    on_conflict: onConflict ?? 'fail',
  })

/** Everything currently recoverable, newest deletion first. */
export const fetchTrash = (signal?: AbortSignal) =>
  getJson<TrashRead>(`${lib()}/file-ops/trash`, signal)

/** Put one deletion's entries back where they came from. */
export const restoreTrashed = (operationId: string) =>
  sendFileOp<FileOperationResult>(`${lib()}/file-ops/trash/restore/${operationId}`, {})

/** Permanently delete trashed entries. The one write-mode action with no undo. */
export const emptyTrash = (olderThanDays?: number) =>
  sendFileOp<EmptyTrashResult>(`${lib()}/file-ops/trash/empty`, {
    older_than_days: olderThanDays ?? null,
  })

// --- Library write mode (ADR-0013) -------------------------------------------
/**
 * Thrown when enabling write mode needs the library's passphrase — either
 * because it was not supplied or because it was wrong. The server answers both
 * identically on purpose, so this carries no more than "ask again".
 */
export class PassphraseRequiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PassphraseRequiredError'
  }
}

export const fetchWriteMode = (libraryId: string, signal?: AbortSignal) =>
  getJson<WriteModeRead>(`/api/v1/libraries/${libraryId}/write-mode`, signal)

/**
 * Turn guarded file operations on or off for one library.
 *
 * Its own sender rather than `send`, because the 401 here is a *prompt*, not a
 * failure: the caller re-asks for the passphrase and retries. `passphrase` also
 * stands in for an unlocked session, so a locked library costs one prompt
 * rather than two.
 */
export async function setLibraryWriteMode(
  libraryId: string,
  enabled: boolean,
  passphrase?: string,
): Promise<WriteModeRead> {
  const response = await hostFetch(resolveApiUrl(`/api/v1/libraries/${libraryId}/write-mode`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled, passphrase: passphrase ?? null }),
  })
  if (!response.ok) {
    let detail = ''
    try {
      detail = apiErrorDetail(await response.json())
    } catch {
      /* non-JSON body */
    }
    if (response.status === 401) {
      throw new PassphraseRequiredError(detail || "This library's passphrase is required.")
    }
    throw new Error(detail || `Request failed (HTTP ${response.status})`)
  }
  return (await response.json()) as WriteModeRead
}

// --- Background jobs ----------------------------------------------------------
export const enqueueScan = () => send<JobRead>(`${lib()}/jobs/scan`, 'POST')

export const enqueueProbe = (libraryId?: string) =>
  send<JobRead>(`${lib(libraryId)}/jobs/probe`, 'POST')

export const enqueueThumbnails = () => send<JobRead>(`${lib()}/jobs/thumbnails`, 'POST')

export const enqueueStoryboards = (libraryId?: string) =>
  send<JobRead>(`${lib(libraryId)}/jobs/storyboards`, 'POST')

/** Fetch the current status/result for a background job. */
export const fetchJob = (id: string, signal?: AbortSignal) =>
  getJson<JobRead>(`/api/v1/jobs/${id}`, signal)

/** Ask a running or queued job to stop.
 *
 * A queued job ends immediately — nothing is running it. A running one stops at
 * its next checkpoint, or sooner: long external work watches the same flag.
 */
export const cancelJob = (id: string) => send<JobRead>(`/api/v1/jobs/${id}/cancel`, 'POST')

/** Jobs running or waiting for a library, oldest first.
 *
 * What a freshly loaded page asks to find work already in progress: job
 * progress otherwise lives only in the mutation that started it, so a reload
 * used to lose track of a scan that was still running.
 */
export const fetchActiveJobs = (libraryId: string, signal?: AbortSignal) =>
  getJson<JobRead[]>(`/api/v1/jobs/active?library_id=${encodeURIComponent(libraryId)}`, signal)

// --- Per-library passphrase lock (ADR-0010) ----------------------------------
export const fetchAuthStatus = (libraryId: string, signal?: AbortSignal) =>
  getJson<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/status`, signal)

export const unlockLibrary = (libraryId: string, passphrase: string) =>
  send<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/unlock`, 'POST', { passphrase })

export const lockLibrary = (libraryId: string) =>
  send<AuthStatus>(`/api/v1/libraries/${libraryId}/auth/lock`, 'POST')

// --- Library ownership lease (ADR-0018) ------------------------------------
// Readable precisely when the library will *not* mount, which is the point: it
// is what a client calls after a lease refusal to learn who holds the library.
export interface LeaseHolder {
  server_uuid: string | null
  machine_name: string | null
  advertised_url: string | null
  heartbeat_at: string | null
}

export interface LibraryOwnership {
  library_id: string
  /** `own` | `released` | `fresh` | `stale` | `unreadable` */
  state: string
  mountable: boolean
  can_take_over: boolean
  /** Set only when the holder advertises a reachable, non-loopback address. */
  redirect_url: string | null
  holder: LeaseHolder | null
  takeover: {
    running: boolean
    error_code: string | null
    error_message: string | null
    /** ISO-8601 UTC; with `observation_seconds`, lets the UI show time left. */
    started_at: string | null
    observation_seconds: number | null
  } | null
}

export const fetchLibraryOwnership = (libraryId: string, signal?: AbortSignal) =>
  getJson<LibraryOwnership>(`/api/v1/libraries/${libraryId}/ownership`, signal)

export const startLibraryTakeover = (libraryId: string) =>
  send<LibraryOwnership>(`/api/v1/libraries/${libraryId}/ownership/takeover`, 'POST')

// --- Device pairing and bearer-token management (ADR-0015) -----------------
export const startDevicePairing = (deviceName: string) =>
  send<PairStartResponse>('/api/v1/auth/pair/start', 'POST', { device_name: deviceName })

export const pollDevicePairing = (pollKey: string, signal?: AbortSignal) =>
  sendSignal<PairPollResponse>('/api/v1/auth/pair/poll', 'POST', signal, {
    poll_key: pollKey,
  })

export const approveDevicePairing = (pairCode: string, libraryIds: string[]) =>
  send<void>('/api/v1/auth/pair/approve', 'POST', {
    pair_code: pairCode,
    library_ids: libraryIds,
  })

export const fetchDevices = (signal?: AbortSignal) =>
  getJson<DeviceRead[]>('/api/v1/auth/devices', signal)

export const revokeDevice = (deviceId: string) =>
  send<void>(`/api/v1/auth/devices/${deviceId}`, 'DELETE')

// --- Grouping plans (ADR-0009) ------------------------------------------------
export type GroupingPlan = components['schemas']['PlanRead']
export type GroupingProposal = components['schemas']['ProposalRead']
export type GroupingPlanSummary = components['schemas']['PlanSummary']
export type GroupingApplyResult = components['schemas']['ApplyResultRead']
/** Each folder's position on the stem dial, and how far that folder's dial goes.
 *
 * Keyed by library-relative folder. The maximum is folder-specific — it is the
 * level at which every filename there is compared on its first segment alone —
 * so the server reports it rather than the client deriving it.
 */
export type GroupingStemLevels = NonNullable<GroupingPlan['stem_levels']>
/** The levels to *generate* with: just the number, per folder. */
export type GroupingStemLevelInput = Record<string, number>

/** The level a folder groups at unless the owner moved its dial.
 *
 * Mirrors the server's `DEFAULT_STEM_LEVEL`. The server stays authoritative — it
 * clamps every level to the folder's maximum and drops an override equal to the
 * default — so this is only used to label the reset action and to default a
 * folder the open plan has not reported a dial for yet.
 */
export const GROUPING_DEFAULT_STEM_LEVEL = 1

/** Suggest a grouping for the active library and store it as the open plan. */
export const generateGroupingPlan = (stemLevels: GroupingStemLevelInput = {}) =>
  send<GroupingPlan>(`${lib()}/grouping/plans`, 'POST', { stem_levels: stemLevels })

export const fetchGroupingPlans = (signal?: AbortSignal): Promise<GroupingPlanSummary[]> =>
  getJson<GroupingPlanSummary[]>(`${lib()}/grouping/plans`, signal)

export const fetchGroupingPlan = (id: string, signal?: AbortSignal): Promise<GroupingPlan> =>
  getJson<GroupingPlan>(`${lib()}/grouping/plans/${id}`, signal)

/** Rename a bundle or collection suggestion while its grouping plan is open. */
export const renameGroupingProposal = (
  planId: string,
  proposalId: string,
  title: string,
): Promise<GroupingProposal> =>
  send<GroupingProposal>(`${lib()}/grouping/plans/${planId}/proposals/${proposalId}`, 'PATCH', {
    title,
  })

/** Switch an existing-bundle suggestion between that target and a new bundle. */
export const setGroupingProposalDestination = (
  planId: string,
  proposalId: string,
  createNewBundle: boolean,
): Promise<GroupingProposal> =>
  send<GroupingProposal>(
    `${lib()}/grouping/plans/${planId}/proposals/${proposalId}/destination`,
    'PUT',
    { create_new_bundle: createNewBundle },
  )

/** Move a file within or across bundle suggestions. */
export const moveGroupingProposalFile = (
  planId: string,
  sourceProposalId: string,
  assetFileId: string,
  targetProposalId: string,
  targetIndex: number,
): Promise<GroupingProposal[]> =>
  send<GroupingProposal[]>(
    `${lib()}/grouping/plans/${planId}/proposals/${sourceProposalId}/files/${assetFileId}/move`,
    'PUT',
    { target_proposal_id: targetProposalId, target_index: targetIndex },
  )

/** Move suggested work under another proposal, a persisted collection, or top level */
export const reparentGroupingProposal = (
  planId: string,
  proposalId: string,
  parentProposalId: string | null,
  targetCollectionId: string | null,
): Promise<GroupingPlan> =>
  send<GroupingPlan>(`${lib()}/grouping/plans/${planId}/proposals/${proposalId}/parent`, 'PUT', {
    parent_proposal_id: parentProposalId,
    target_collection_id: targetCollectionId,
  })

/** Move one directory along the stem dial and re-suggest that directory in place.
 *
 * Unlike generating a plan, this edits the open plan: every proposal outside the
 * directory keeps its identity (and with it every owner edit), so the response
 * is the same plan with only that directory's rows replaced. The server clamps
 * the level to that folder's own maximum.
 */
export const setGroupingDirectoryStemLevel = (
  planId: string,
  directory: string,
  level: number,
): Promise<GroupingPlan> =>
  send<GroupingPlan>(`${lib()}/grouping/plans/${planId}/stem-levels`, 'PUT', { directory, level })

/** Turn a bundle suggestion into a collection of bundles, or back into one bundle.
 *
 * Returns the whole plan, not the one proposal: a conversion adds or removes
 * sibling rows, so the client's tree has changed shape.
 */
export const setGroupingProposalKind = (
  planId: string,
  proposalId: string,
  kind: 'bundle' | 'container',
): Promise<GroupingPlan> =>
  send<GroupingPlan>(`${lib()}/grouping/plans/${planId}/proposals/${proposalId}/kind`, 'PUT', {
    kind,
  })

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

// --- Manual bundling assistant ------------------------------------------------
// Suggestions are read-only (generated on dialog open); the mutations are the
// explicit, metadata-only actions that turn unbundled files into confirmed
// bundles. Nothing here moves, copies, renames, or deletes a file on disk.
const mb = () => `${lib()}/manual-bundling`

// A selection of unbundled files, as backend ids (Unbundled list) and/or File
// View relative paths (unlinked paths are auto-linked server-side at apply).
export interface FileSelection {
  fileIds?: string[]
  relativePaths?: string[]
}
const selBody = (s: FileSelection) => ({
  file_ids: s.fileIds ?? [],
  relative_paths: s.relativePaths ?? [],
})

export const suggestTargetBundles = (sel: FileSelection, limit = 10) =>
  send<{ suggestions: TargetSuggestion[] }>(`${mb()}/suggest-targets`, 'POST', {
    ...selBody(sel),
    limit,
  }).then((r) => r.suggestions)

export const suggestUnbundledFilesForBundle = (bundleId: string, limit = 30) =>
  getJson<{ suggestions: FileSuggestion[] }>(
    `${mb()}/bundles/${bundleId}/suggest-files?limit=${limit}`,
  ).then((r) => r.suggestions)

export const suggestBundleFromFiles = (sel: FileSelection, limit = 30) =>
  send<BundleDraft>(`${mb()}/suggest-bundle`, 'POST', { ...selBody(sel), limit })

export const addUnbundledFilesToBundle = (targetBundleId: string, sel: FileSelection) =>
  send<ManualBundleResult>(`${mb()}/add-files`, 'POST', {
    target_bundle_id: targetBundleId,
    ...selBody(sel),
  })

export const createBundleFromUnbundled = (sel: FileSelection, title?: string | null) =>
  send<ManualBundleResult>(`${mb()}/create-bundle`, 'POST', {
    ...selBody(sel),
    title: title ?? null,
  })

export const createEmptyBundle = (title?: string | null) =>
  send<ManualBundleResult>(`${mb()}/create-empty-bundle`, 'POST', { title: title ?? null })

// The flat "to-bundle queue": a cross-library page of not-yet-bundled files,
// shaped like File Browser entries so one file row renders both surfaces.
export type UnbundledFilesPage = components['schemas']['UnbundledFilesPage']
export const fetchUnbundledFiles = (offset = 0, limit = 200, signal?: AbortSignal) =>
  getJson<UnbundledFilesPage>(`${mb()}/unbundled-files?offset=${offset}&limit=${limit}`, signal)

// --- File Browser (read-only filesystem browsing) -------------------------------
export function fetchFileBrowserEntries(
  path: string | null,
  signal?: AbortSignal,
): Promise<FileBrowserListing> {
  const q = path ? `?path=${encodeURIComponent(path)}` : ''
  return getJson<FileBrowserListing>(`${lib()}/file-browser/entries${q}`, signal)
}

export function fetchBundle(id: string, signal?: AbortSignal): Promise<BundleRead> {
  return getJson<BundleRead>(`${lib()}/bundles/${id}`, signal)
}

export function fetchBundleFiles(id: string, signal?: AbortSignal): Promise<FileRead[]> {
  return getJson<FileRead[]>(`${lib()}/bundles/${id}/files`, signal)
}

export function fetchFileRepairCandidate(
  bundleId: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<FileRepairCandidate | null> {
  return getJson<FileRepairCandidate | null>(
    `${lib()}/bundles/${bundleId}/files/${fileId}/repair-candidate`,
    signal,
  )
}

/**
 * URL for a bundle's cover thumbnail. The endpoint path is stable, so the
 * browser would serve a stale cached image after the cover changes; passing
 * `coverKey` (`cover_key` on a browse summary or bundle `updated_at` on detail
 * surfaces) appends a cache-busting query param so regenerated bytes show
 * without a manual refresh even when the selected file id stays unchanged.
 */
export function thumbnailUrl(bundleId: string, coverKey?: string | null): string {
  const base = `${lib()}/bundles/${bundleId}/thumbnail`
  return resolveAssetUrl(coverKey ? `${base}?c=${encodeURIComponent(coverKey)}` : base)
}

export function fileThumbnailUrl(bundleId: string, fileId: string, version?: string): string {
  const base = `${lib()}/bundles/${bundleId}/files/${fileId}/thumbnail`
  return resolveAssetUrl(version ? `${base}?v=${encodeURIComponent(version)}` : base)
}

export function setCoverFrame(fileId: string, time: number): Promise<FileRead> {
  return send<FileRead>(`${lib()}/files/${fileId}/cover-frame`, 'POST', { time })
}

export function clearCoverFrame(fileId: string): Promise<FileRead> {
  return send<FileRead>(`${lib()}/files/${fileId}/cover-frame`, 'DELETE')
}

/**
 * URL for a collection's cover thumbnail (its chosen or auto-picked cover
 * bundle). `coverKey` (the collection's `updated_at`) busts the browser cache
 * when its selected or automatically resolved bundle cover changes.
 */
export function collectionThumbnailUrl(collectionId: string, coverKey?: string | null): string {
  const base = `${lib()}/collections/${collectionId}/thumbnail`
  return resolveAssetUrl(coverKey ? `${base}?c=${encodeURIComponent(coverKey)}` : base)
}

export function fileContentUrl(fileId: string): string {
  return resolveAssetUrl(`${lib()}/files/${fileId}/content`)
}

export type PreviewSize = 640 | 1600 | 2560

// URL for a lazily generated WebP image preview derivative
export function filePreviewUrl(file: FileRead, size: PreviewSize): string {
  const q = new URLSearchParams({ size: String(size) })
  if (file.quick_fingerprint) q.set('v', file.quick_fingerprint)
  return resolveAssetUrl(`${lib()}/files/${file.id}/preview?${q.toString()}`)
}

/** WebP preview of a File Browser entry addressed by library-relative path */
export function fileBrowserPreviewUrl(path: string, size: PreviewSize = 1600): string {
  const q = new URLSearchParams({ path, size: String(size) })
  return resolveAssetUrl(`${lib()}/file/preview?${q.toString()}`)
}

/** Raw bytes of a File Browser entry (library-relative path, read-only). */
export function fileBrowserContentUrl(path: string): string {
  return resolveAssetUrl(`${lib()}/file?path=${encodeURIComponent(path)}`)
}

/** The server-generated contact-sheet frame grid for one video file. */
export function fileContactSheetUrl(fileId: string, cols = 4, rows = 4, width = 2048): string {
  return resolveAssetUrl(
    `${lib()}/files/${fileId}/contact-sheet?cols=${cols}&rows=${rows}&width=${width}`,
  )
}

export function fileStreamUrl(fileId: string): string {
  return resolveAssetUrl(`${lib()}/files/${fileId}/stream`)
}

// The version bypasses legacy immutable VTTs; current indexes revalidate via no-cache
export function fileStoryboardUrl(fileId: string): string {
  return resolveAssetUrl(
    `${lib()}/files/${fileId}/storyboard.vtt?v=${STORYBOARD_INDEX_CACHE_VERSION}`,
  )
}

// --- Taxonomy (for the tag editor) ------------------------------------------
export const fetchTags = (signal?: AbortSignal) => fetchAllPaged<TagRead>(`${lib()}/tags`, signal)
export const createTag = (payload: TagCreate) => send<TagRead>(`${lib()}/tags`, 'POST', payload)

// All Tags management (Slice 3). Metadata-only: renaming/deleting/reordering a
// tag never touches a file or bundle.
export const updateTag = (
  id: string,
  patch: { name?: string; parent_id?: string | null; color?: string | null },
  version?: number,
) => send<TagRead>(`${lib()}/tags/${id}`, 'PATCH', patch, version)

/** Delete a tag. `cascade` also removes its child tags, which the server
 *  refuses without, so a parent is never taken by accident. */
export const deleteTag = (id: string, cascade = false) =>
  send<void>(`${lib()}/tags/${id}${cascade ? '?cascade=true' : ''}`, 'DELETE')

/** What deleting a tag would remove — the numbers the prompt prints. */
export const fetchTagDeleteImpact = (id: string, signal?: AbortSignal) =>
  getJson<{ tags: number; bundles: number }>(`${lib()}/tags/${id}/delete-impact`, signal)
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

export const updateBundleCursor = (id: string, fileId: string) =>
  send<BundleCursorRead>(`${lib()}/bundles/${id}/cursor`, 'PUT', { file_id: fileId })

/** Stamp "last opened" for the Recent view's Date Opened order. Fire-and-forget:
 *  opening a bundle must not wait on it, and must not fail because of it. */
export const markBundleOpened = (id: string) =>
  send<void>(`${lib()}/bundles/${id}/opened`, 'POST').catch(() => undefined)

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

// Manual drag-reorder of bundles (MANUAL sort). collectionId null = global order.
export const reorderBundles = (
  collectionId: string | null,
  movedIds: string[],
  beforeId: string | null,
) =>
  send<{ ordered_ids: string[] }>(`${lib()}/bundles/reorder`, 'PUT', {
    collection_id: collectionId,
    moved_ids: movedIds,
    before_id: beforeId,
  })

// "Clean up by…": rewrite the whole scope's manual order to a chosen toolbar sort.
export const cleanupBundleOrder = (
  collectionId: string | null,
  sort: CleanupSort,
  order: SortOrder,
) =>
  send<void>(`${lib()}/bundles/cleanup-order`, 'POST', { collection_id: collectionId, sort, order })

export const removeFile = (bundleId: string, fileId: string) =>
  send<void>(`${lib()}/bundles/${bundleId}/files/${fileId}`, 'DELETE')

export const repairFile = (bundleId: string, fileId: string, replacementFileId: string) =>
  send<FileRead>(`${lib()}/bundles/${bundleId}/files/${fileId}/repair`, 'PUT', {
    replacement_file_id: replacementFileId,
  })

export const batchUpdate = (payload: BatchUpdate) =>
  send<{ updated: number }>(`${lib()}/bundles/batch`, 'POST', payload)

// Removal is metadata-only on both endpoints: the bundle's/collection's rows are
// deleted but no file on disk is ever touched (AGENTS.md §3, §10). Deleting a
// collection floats its children to the root and drops bundle memberships; the
// bundles themselves are not deleted.
export const deleteBundle = (id: string) => send<void>(`${lib()}/bundles/${id}`, 'DELETE')

/**
 * Delete a bundle *and* send its files to the trash (ADR-0013 §3.2).
 *
 * A separate route from `deleteBundle`, not a flag on it: dissolving a grouping
 * is metadata-only and always allowed, while deleting the files is a guarded
 * write that a read-only library refuses. Returns null for an empty bundle,
 * which had no files to trash and so produced no undoable operation.
 */
export const deleteBundleWithFiles = (id: string) =>
  send<FileOperationResult | null>(`${lib()}/bundles/${id}/delete-with-files`, 'POST')

// `cascade` also removes the collection's descendant subcollections; otherwise
// they float to the library root. Bundles and files are kept either way.
export const deleteCollection = (id: string, cascade = false) =>
  send<void>(`${lib()}/collections/${id}?cascade=${cascade}`, 'DELETE')

export async function fetchHealth(signal?: AbortSignal, baseUrl?: string): Promise<HealthStatus> {
  // An explicit `baseUrl` probes that server without touching the module's
  // configured base — verification must be able to ask "is anything there?"
  // without repointing the app at the answer (plan 3 §7.1 activation).
  if (baseUrl) {
    return getJson<HealthStatus>(`${baseUrl.replace(/\/+$/, '')}/api/v1/health`, signal)
  }
  return getJson<HealthStatus>('/api/v1/health', signal)
}
