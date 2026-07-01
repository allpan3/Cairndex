import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type BatchUpdate,
  type BrowseParams,
  type BundlePatch,
  type FilePatch,
  type FilterExpression,
  type JobRead,
  type LibraryCreate,
  type LibraryRegister,
  type SmartCollectionCreate,
  type SmartCollectionUpdate,
  addUnbundledFilesToBundle,
  batchUpdate,
  browseBundles,
  createBundleFromUnbundled,
  createEmptyBundle,
  createLibrary,
  createSmartCollection,
  deleteBundle,
  deleteCollection,
  deleteSmartCollection,
  applyGroupingPlan,
  enqueueProbe,
  enqueueScan,
  enqueueThumbnails,
  fetchAuthStatus,
  fetchJob,
  lockLibrary,
  unlockLibrary,
  fetchGroupingPlan,
  fetchGroupingPlans,
  generateGroupingPlan,
  fetchAllCollections,
  fetchBundle,
  fetchBundleCollections,
  fetchBundleFiles,
  fetchBundleTags,
  fetchCollectionCounts,
  fetchFileViewEntries,
  fetchLibraries,
  fetchPlaybackManifest,
  fetchSmartCollections,
  fetchTagCounts,
  fetchTagGroupTags,
  fetchTagGroups,
  fetchTags,
  fetchViewCounts,
  previewFilter,
  registerLibrary,
  removeFile,
  reorderFiles,
  setBundleCollections,
  setBundleTags,
  suggestBundleFromFiles,
  suggestTargetBundles,
  suggestUnbundledFilesForBundle,
  updateBundle,
  updateFile,
  updateSmartCollection,
} from './client'

export type BrowseQuery = Omit<BrowseParams, 'offset'>

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

type JobProgressFn = (job: JobRead | null) => void

// Wait for a queued/running job to finish so dependent queries refetch fresh
// data. ``onProgress`` (when given) receives each polled snapshot so the UI can
// render live phase/message/progress; it fires for the initial state too.
async function waitForJob(job: JobRead, onProgress?: JobProgressFn): Promise<JobRead> {
  let current = job
  onProgress?.(current)
  while (!TERMINAL_JOB_STATUSES.has(current.status)) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    current = await fetchJob(job.id)
    onProgress?.(current)
  }
  if (current.status === 'failed') {
    throw new Error(current.error ?? 'Background job failed.')
  }
  if (current.status === 'cancelled') {
    throw new Error('Background job was cancelled.')
  }
  return current
}

// Invalidate all library surfaces whose content changes after a maintenance job
function invalidateLibraryContent(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'browse',
    'view-counts',
    'collection-counts',
    'tag-counts',
    'file-view',
    'grouping-plans',
    'grouping-plan',
    'bundle',
    'bundle-files',
  ])
    qc.invalidateQueries({ queryKey: [key] })
}

/**
 * Infinite browse query: pages are fetched by offset as the virtualized grid
 * nears the end, so several thousand bundles stay responsive.
 */
export function useBrowse(query: BrowseQuery) {
  return useInfiniteQuery({
    queryKey: ['browse', query],
    queryFn: ({ pageParam, signal }) => browseBundles({ ...query, offset: pageParam }, signal),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.limit < last.total ? last.offset + last.limit : undefined,
  })
}

export function useViewCounts() {
  return useQuery({
    queryKey: ['view-counts'],
    queryFn: ({ signal }) => fetchViewCounts(signal),
  })
}

/** Live match-count for a draft filter, debounced by query key (the AST). */
export function useFilterPreview(filter: FilterExpression | null) {
  return useQuery({
    queryKey: ['filter-preview', filter],
    queryFn: ({ signal }) => (filter ? previewFilter(filter, signal) : Promise.resolve(0)),
    enabled: filter !== null,
  })
}

export function usePlaybackManifest(bundleId: string | null) {
  return useQuery({
    queryKey: ['playback', bundleId],
    queryFn: ({ signal }) => fetchPlaybackManifest(bundleId!, signal),
    enabled: bundleId !== null,
  })
}

export function useSmartCollections() {
  return useQuery({
    queryKey: ['smart-collections'],
    queryFn: ({ signal }) => fetchSmartCollections(signal),
  })
}

export function useSmartCollectionMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['smart-collections'] })
  return {
    create: useMutation({
      mutationFn: (payload: SmartCollectionCreate) => createSmartCollection(payload),
      onSuccess: invalidate,
    }),
    update: useMutation({
      mutationFn: ({
        id,
        payload,
        version,
      }: {
        id: string
        payload: SmartCollectionUpdate
        version?: number
      }) => updateSmartCollection(id, payload, version),
      // Refetch on conflict too, so the editor shows the latest server state.
      onSettled: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteSmartCollection(id),
      onSuccess: invalidate,
    }),
  }
}

// --- Libraries (registry) + File View ----------------------------------------
export function useLibraries() {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: ({ signal }) => fetchLibraries(signal),
  })
}

export function useLibraryMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['libraries'] })
  return {
    create: useMutation({
      mutationFn: (payload: LibraryCreate) => createLibrary(payload),
      onSuccess: invalidate,
    }),
    register: useMutation({
      mutationFn: (payload: LibraryRegister) => registerLibrary(payload),
      onSuccess: invalidate,
    }),
  }
}

// --- Per-library passphrase lock (ADR-0010) ----------------------------------
/** Lock state of a library for the current session; drives the lock screen. */
export function useLibraryAuth(libraryId: string | null) {
  return useQuery({
    queryKey: ['auth-status', libraryId],
    queryFn: ({ signal }) => fetchAuthStatus(libraryId!, signal),
    enabled: libraryId !== null,
  })
}

export function useLibraryLock(libraryId: string | null) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['auth-status', libraryId] })
    // A lock/unlock flips content accessibility, so refresh the library surfaces.
    invalidateLibraryContent(qc)
  }
  return {
    unlock: useMutation({
      mutationFn: (passphrase: string) => unlockLibrary(libraryId!, passphrase),
      onSuccess: invalidate,
    }),
    lock: useMutation({
      mutationFn: () => lockLibrary(libraryId!),
      onSuccess: invalidate,
    }),
  }
}

// Open grouping review when a completed scan produced suggestions
function notifyGroupingPlan(job: JobRead, onGroupingPlan?: (planId: string) => void) {
  const result = job.result as Record<string, unknown> | null
  const proposalCount = Number(result?.grouping_proposal_count ?? 0)
  const planId = typeof result?.grouping_plan_id === 'string' ? result.grouping_plan_id : null
  if (planId !== null && proposalCount > 0) {
    onGroupingPlan?.(planId)
  }
}

interface MaintenanceOptions {
  onGroupingPlan?: (planId: string) => void
  // Receives each polled job snapshot (and null when the run settles) so the
  // sidebar can render a live progress bar with phase/message.
  onProgress?: JobProgressFn
}

/** Enqueue scan-only discovery/repair and grouping suggestion preparation */
export function useScan(options: MaintenanceOptions = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const scanJob = await waitForJob(await enqueueScan(), options.onProgress)
      return scanJob
    },
    onSuccess: (job) => {
      invalidateLibraryContent(qc)
      notifyGroupingPlan(job, options.onGroupingPlan)
    },
    onSettled: () => options.onProgress?.(null),
  })
}

/** Enqueue the primary library update flow: scan, grouping suggestions, then metadata probe */
export function useUpdateLibrary(options: MaintenanceOptions = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const scanJob = await waitForJob(await enqueueScan(), options.onProgress)
      await waitForJob(await enqueueProbe(), options.onProgress)
      return scanJob
    },
    onSuccess: (job) => {
      invalidateLibraryContent(qc)
      notifyGroupingPlan(job, options.onGroupingPlan)
    },
    onSettled: () => options.onProgress?.(null),
  })
}

// Probe (ffprobe tech metadata) and thumbnail generation are library-wide jobs
// enqueued to the registry queue (ADR-0008 phase 7); the worker runs them async.
// We invalidate the views whose contents they refresh once the job is accepted.
export function useProbe(options: { onProgress?: JobProgressFn } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => waitForJob(await enqueueProbe(), options.onProgress),
    onSuccess: () => {
      for (const key of ['bundle', 'bundle-files', 'browse']) {
        qc.invalidateQueries({ queryKey: [key] })
      }
    },
    onSettled: () => options.onProgress?.(null),
  })
}

export function useThumbnails(options: { onProgress?: JobProgressFn } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => waitForJob(await enqueueThumbnails(), options.onProgress),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['browse'] }),
    onSettled: () => options.onProgress?.(null),
  })
}

// --- Grouping plans (ADR-0009) -----------------------------------------------
export function useGroupingPlans(enabled = true) {
  return useQuery({
    queryKey: ['grouping-plans'],
    queryFn: ({ signal }) => fetchGroupingPlans(signal),
    enabled,
  })
}

export function useGroupingPlan(id: string | null) {
  return useQuery({
    queryKey: ['grouping-plan', id],
    queryFn: ({ signal }) => fetchGroupingPlan(id as string, signal),
    enabled: id !== null,
  })
}

export function useGenerateGroupingPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => generateGroupingPlan(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['grouping-plans'] }),
  })
}

export function useApplyGroupingPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, proposalIds }: { id: string; proposalIds?: string[] }) =>
      applyGroupingPlan(id, proposalIds),
    onSuccess: () => {
      // Applying confirms bundles and may create collections + subtitle links.
      for (const key of [
        'browse',
        'view-counts',
        'collections',
        'collection-counts',
        'grouping-plans',
        'grouping-plan',
        'bundle',
        'bundle-files',
      ])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

// --- Manual bundling assistant (Unbundled staging follow-up to ADR-0009) -----
// Suggestions are generated automatically when a dialog opens (read-only); the
// mutations are explicit and metadata-only. Each mutation invalidates the full
// set of library-content surfaces (browse, counts, bundle detail, grouping) so
// resolved files leave Unbundled and appear in their confirmed bundle.

/** Confirmed bundles the selected unbundled files most likely belong to. */
export function useTargetSuggestions(fileIds: string[], enabled = true) {
  return useQuery({
    queryKey: ['mb-target-suggestions', fileIds],
    queryFn: () => suggestTargetBundles(fileIds),
    enabled: enabled && fileIds.length > 0,
  })
}

/** Unbundled files that most likely belong in a bundle. */
export function useUnbundledFileSuggestions(bundleId: string | null) {
  return useQuery({
    queryKey: ['mb-file-suggestions', bundleId],
    queryFn: () => suggestUnbundledFilesForBundle(bundleId as string),
    enabled: bundleId !== null,
  })
}

/** A proposed title/roles for a seed selection, plus nearby unbundled files. */
export function useBundleDraft(fileIds: string[]) {
  return useQuery({
    queryKey: ['mb-bundle-draft', fileIds],
    queryFn: () => suggestBundleFromFiles(fileIds),
    enabled: fileIds.length > 0,
  })
}

/** Manual search fallback for a target bundle: whole-library FTS over confirmed
 * bundles (unbundled files are already excluded from the normal browse views). */
export function useConfirmedBundleSearch(query: string) {
  const trimmed = query.trim()
  return useQuery({
    queryKey: ['mb-bundle-search', trimmed],
    queryFn: ({ signal }) =>
      browseBundles(
        { view: 'all', sort: 'title', order: 'asc', offset: 0, limit: 20, search: trimmed },
        signal,
      ),
    enabled: trimmed.length > 0,
  })
}

export function useManualBundling() {
  const qc = useQueryClient()
  const invalidate = () => invalidateLibraryContent(qc)
  return {
    addFiles: useMutation({
      mutationFn: ({ bundleId, fileIds }: { bundleId: string; fileIds: string[] }) =>
        addUnbundledFilesToBundle(bundleId, fileIds),
      onSuccess: invalidate,
    }),
    createFromFiles: useMutation({
      mutationFn: ({ fileIds, title }: { fileIds: string[]; title?: string | null }) =>
        createBundleFromUnbundled(fileIds, title),
      onSuccess: invalidate,
    }),
    createEmpty: useMutation({
      mutationFn: (title?: string | null) => createEmptyBundle(title),
      onSuccess: invalidate,
    }),
  }
}

/** List directory entries for a library-relative path (null = library root). */
export function useFileView(path: string | null, enabled = true) {
  return useQuery({
    queryKey: ['file-view', path ?? ''],
    queryFn: ({ signal }) => fetchFileViewEntries(path, signal),
    enabled,
  })
}

export function useCollections() {
  return useQuery({
    queryKey: ['collections'],
    queryFn: ({ signal }) => fetchAllCollections(signal),
  })
}

export function useCollectionCounts() {
  return useQuery({
    queryKey: ['collection-counts'],
    queryFn: ({ signal }) => fetchCollectionCounts(signal),
  })
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => fetchTags(signal) })
}

export function useTagGroups() {
  return useQuery({ queryKey: ['tag-groups'], queryFn: ({ signal }) => fetchTagGroups(signal) })
}

export function useTagCounts() {
  return useQuery({
    queryKey: ['tag-counts'],
    queryFn: ({ signal }) => fetchTagCounts(signal),
  })
}

/** Map of tag-group id → its member tag ids, for the tag picker's group tabs. */
export function useTagGroupMemberships() {
  const groups = useTagGroups()
  const ids = (groups.data ?? []).map((g) => g.id)
  return useQuery({
    queryKey: ['tag-group-memberships', ids],
    enabled: groups.data !== undefined,
    queryFn: async () => {
      const entries = await Promise.all(
        (groups.data ?? []).map(async (g) => [g.id, await fetchTagGroupTags(g.id)] as const),
      )
      return Object.fromEntries(entries) as Record<string, string[]>
    },
  })
}

export function useBundle(id: string | null) {
  return useQuery({
    queryKey: ['bundle', id],
    queryFn: ({ signal }) => fetchBundle(id as string, signal),
    enabled: id !== null,
  })
}

export function useBundleFiles(id: string | null) {
  return useQuery({
    queryKey: ['bundle-files', id],
    queryFn: ({ signal }) => fetchBundleFiles(id as string, signal),
    enabled: id !== null,
  })
}

export function useBundleTags(id: string | null) {
  return useQuery({
    queryKey: ['bundle-tags', id],
    queryFn: ({ signal }) => fetchBundleTags(id as string, signal),
    enabled: id !== null,
  })
}

export function useBundleCollections(id: string | null) {
  return useQuery({
    queryKey: ['bundle-collections', id],
    queryFn: ({ signal }) => fetchBundleCollections(id as string, signal),
    enabled: id !== null,
  })
}

// --- Mutations ---------------------------------------------------------------
// After a write, invalidate the queries whose results may have changed so the
// UI reflects the edit (and survives a manual reload).

export function useUpdateBundle(id: string, version?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: BundlePatch) => updateBundle(id, patch, version),
    // onSettled (not onSuccess) so a 409 conflict also refetches the bundle —
    // the editor then shows whatever the other client wrote (ADR-0008 phase 9).
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['bundle', id] })
      qc.invalidateQueries({ queryKey: ['browse'] })
    },
  })
}

export function useSetBundleTags(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => setBundleTags(id, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bundle-tags', id] })
      qc.invalidateQueries({ queryKey: ['tag-counts'] })
      qc.invalidateQueries({ queryKey: ['view-counts'] })
      qc.invalidateQueries({ queryKey: ['browse'] })
    },
  })
}

export function useSetBundleCollections(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => setBundleCollections(id, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bundle-collections', id] })
      qc.invalidateQueries({ queryKey: ['collection-counts'] })
      qc.invalidateQueries({ queryKey: ['view-counts'] })
      qc.invalidateQueries({ queryKey: ['browse'] })
    },
  })
}

export function useFileMutations(bundleId: string) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['bundle-files', bundleId] })
    qc.invalidateQueries({ queryKey: ['bundle', bundleId] })
    qc.invalidateQueries({ queryKey: ['browse'] })
  }
  return {
    update: useMutation({
      mutationFn: ({
        fileId,
        patch,
        version,
      }: {
        fileId: string
        patch: FilePatch
        version?: number
      }) => updateFile(bundleId, fileId, patch, version),
      onSettled: invalidate,
    }),
    reorder: useMutation({
      mutationFn: (orderedIds: string[]) => reorderFiles(bundleId, orderedIds),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (fileId: string) => removeFile(bundleId, fileId),
      onSuccess: invalidate,
    }),
  }
}

/**
 * Delete one or more bundles (metadata only — files stay on disk). Accepts a
 * list so a multi-selection can be removed in one action; deletes run in
 * parallel and the affected library surfaces are refetched once all settle.
 */
export function useDeleteBundles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => deleteBundle(id))),
    onSuccess: () => {
      for (const key of [
        'browse',
        'view-counts',
        'collection-counts',
        'tag-counts',
        'bundle',
        'bundle-files',
      ])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

/**
 * Delete a collection (metadata only). Children float to the library root and
 * bundle memberships drop server-side; no bundle or file is removed, so we
 * refetch the collection tree, counts, and the browse grid.
 */
export function useDeleteCollection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, cascade }: { id: string; cascade: boolean }) =>
      deleteCollection(id, cascade),
    onSuccess: () => {
      for (const key of [
        'collections',
        'collection-counts',
        'view-counts',
        'browse',
        'bundle-collections',
      ])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

export function useBatchUpdate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: BatchUpdate) => batchUpdate(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['browse'] })
      qc.invalidateQueries({ queryKey: ['tag-counts'] })
      qc.invalidateQueries({ queryKey: ['collection-counts'] })
      qc.invalidateQueries({ queryKey: ['view-counts'] })
    },
  })
}
