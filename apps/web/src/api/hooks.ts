import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'

import {
  type BatchUpdate,
  type BrowseParams,
  type BundleBrowsePage,
  type BundlePatch,
  type BundleSummary,
  type CleanupSort,
  type CollectionCreate,
  type CollectionRead,
  type SortOrder,
  type FacetParams,
  type FilePatch,
  type FileSelection,
  type FilterExpression,
  type JobRead,
  type LibraryCreate,
  type LibraryRegister,
  type SmartCollectionCreate,
  type SmartCollectionUpdate,
  type TagCreate,
  type TagRead,
  addUnbundledFilesToBundle,
  batchUpdate,
  browseBundles,
  createBundleFromUnbundled,
  createCollection,
  createEmptyBundle,
  createLibrary,
  createTag,
  deleteTag,
  updateTag,
  fetchUnbundledFiles,
  createSmartCollection,
  deleteBundle,
  deleteCollection,
  deleteSmartCollection,
  applyGroupingPlan,
  enqueueProbe,
  enqueueScan,
  enqueueStoryboards,
  enqueueThumbnails,
  fetchAuthStatus,
  fetchJob,
  lockLibrary,
  unlockLibrary,
  fetchGroupingPlan,
  fetchGroupingPlans,
  generateGroupingPlan,
  fetchAllCollections,
  fetchCollectionStats,
  fetchBundle,
  fetchBundleCollections,
  fetchBundleFiles,
  fetchBundleTags,
  fetchCollectionCounts,
  fetchFacets,
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
  renameCollection,
  updateCollection,
  reorderCollections,
  cleanupCollectionOrder,
  reorderBundles,
  cleanupBundleOrder,
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

// Watch a non-blocking job while keeping terminal failures visible in progress UI
async function watchOptionalJob(job: Promise<JobRead>, onProgress?: JobProgressFn): Promise<void> {
  try {
    await waitForJob(await job, onProgress)
    onProgress?.(null)
  } catch {
    // waitForJob already emitted the terminal failed/cancelled snapshot
  }
}

// Invalidate all library surfaces whose content changes after a maintenance job
function invalidateLibraryContent(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'browse',
    'view-counts',
    'collection-counts',
    'tag-counts',
    'file-view',
    'unbundled-files',
    'grouping-plans',
    'grouping-plan',
    'bundle',
    'bundle-files',
    'playback',
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

/** Faceted counts for a toolbar filter popover, scoped to the current browse
 * context. Keyed by the full params so it refetches when the scope changes. */
export function useFacets(params: FacetParams, enabled = true) {
  return useQuery({
    queryKey: ['facets', params],
    queryFn: ({ signal }) => fetchFacets(params, signal),
    enabled,
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

/** Enqueue the primary library update flow: scan, grouping suggestions, then probe */
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
      void watchOptionalJob(enqueueStoryboards(), options.onProgress)
    },
    onSettled: (_data, error) => {
      if (error) options.onProgress?.(null)
    },
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
      // Applying confirms bundles and may create collections + subtitle links —
      // so files leave Unbundled and the File View badges change.
      for (const key of [
        'browse',
        'view-counts',
        'collections',
        'collection-counts',
        'unbundled-files',
        'file-view',
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

const hasSelection = (sel: FileSelection) =>
  (sel.fileIds?.length ?? 0) > 0 || (sel.relativePaths?.length ?? 0) > 0

/** The flat "to-bundle queue": all not-yet-bundled files, cross-library. */
export function useUnbundledFiles(enabled = true) {
  return useInfiniteQuery({
    queryKey: ['unbundled-files'],
    queryFn: ({ pageParam, signal }) => fetchUnbundledFiles(pageParam, 200, signal),
    initialPageParam: 0,
    getNextPageParam: (last) =>
      last.offset + last.limit < last.total ? last.offset + last.limit : undefined,
    enabled,
  })
}

/** Confirmed bundles the selected unbundled files most likely belong to. */
export function useTargetSuggestions(sel: FileSelection, enabled = true) {
  return useQuery({
    queryKey: ['mb-target-suggestions', sel],
    queryFn: () => suggestTargetBundles(sel),
    enabled: enabled && hasSelection(sel),
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
export function useBundleDraft(sel: FileSelection) {
  return useQuery({
    queryKey: ['mb-bundle-draft', sel],
    queryFn: () => suggestBundleFromFiles(sel),
    enabled: hasSelection(sel),
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
      mutationFn: ({ bundleId, sel }: { bundleId: string; sel: FileSelection }) =>
        addUnbundledFilesToBundle(bundleId, sel),
      onSuccess: invalidate,
    }),
    createFromFiles: useMutation({
      mutationFn: ({ sel, title }: { sel: FileSelection; title?: string | null }) =>
        createBundleFromUnbundled(sel, title),
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

/** Create a tag inline from a picker's search box (no matches → "Create …"). */
export function useCreateTag() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: TagCreate) => createTag(payload),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tags'] }),
  })
}

/** Rename/delete/reparent tags for the All Tags management page (Slice 3). */
export function useTagMutations() {
  const qc = useQueryClient()
  // A tag change can affect the tree, its counts, group membership, and any
  // browse/filter that references tags.
  const invalidate = () => {
    for (const key of [
      'tags',
      'tag-counts',
      'tag-group-memberships',
      'browse',
      'bundle-tags',
      'view-counts',
    ])
      qc.invalidateQueries({ queryKey: [key] })
  }
  return {
    rename: useMutation({
      mutationFn: ({ id, name, version }: { id: string; name: string; version?: number }) =>
        updateTag(id, { name }, version),
      // onSettled so a 409 conflict also refetches the latest tag state.
      onSettled: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteTag(id),
      onSuccess: invalidate,
    }),
    // Drag-to-reparent: move a tag under a new parent (null = top level). The tree
    // is ordered by name, so there's no manual sibling order to maintain.
    // Optimistic so the tag jumps to its new home immediately; roll back on error.
    reparent: useMutation({
      mutationFn: ({
        id,
        parentId,
        version,
      }: {
        id: string
        parentId: string | null
        version?: number
      }) => updateTag(id, { parent_id: parentId }, version),
      onMutate: async ({ id, parentId }) => {
        await qc.cancelQueries({ queryKey: ['tags'] })
        const prev = qc.getQueryData<TagRead[]>(['tags'])
        qc.setQueryData<TagRead[]>(['tags'], (old) =>
          old?.map((t) => (t.id === id ? { ...t, parent_id: parentId } : t)),
        )
        return { prev }
      },
      onError: (_e, _v, ctx) => {
        if (ctx?.prev) qc.setQueryData(['tags'], ctx.prev)
      },
      onSettled: invalidate,
    }),
  }
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
      // Removing a file re-stages it into Unbundled (a fresh provisional bundle),
      // so the Unbundled list, File View badges, and the sidebar count must
      // refresh too — not just this bundle's files.
      onSuccess: () => {
        invalidate()
        for (const key of ['unbundled-files', 'file-view', 'view-counts'])
          qc.invalidateQueries({ queryKey: [key] })
      },
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
      // Deleting a confirmed bundle re-stages its files into Unbundled, so the
      // Unbundled list + File View badges must refresh too.
      for (const key of [
        'browse',
        'view-counts',
        'collection-counts',
        'tag-counts',
        'unbundled-files',
        'file-view',
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

/** Create a collection (sidebar "+ Collection"); refetches the tree and the
 * per-collection counts so the new (empty) collection shows its 0 right away. */
export function useCreateCollection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: CollectionCreate) => createCollection(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] })
      qc.invalidateQueries({ queryKey: ['collection-counts'] })
    },
  })
}

/** Rename a collection (sidebar inline-edit after creating or on request). */
export function useRenameCollection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, name, version }: { id: string; name: string; version?: number }) =>
      renameCollection(id, name, version),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  })
}

/** Counts for the collection inspector (direct/leaf bundles + subcollections). */
export function useCollectionStats(collectionId: string | null) {
  return useQuery({
    queryKey: ['collection-stats', collectionId],
    queryFn: ({ signal }) => fetchCollectionStats(collectionId as string, signal),
    enabled: collectionId !== null,
  })
}

/** Edit a collection's name/note/cover from the collection inspector. */
export function useUpdateCollection() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      patch,
      version,
    }: {
      id: string
      patch: {
        name?: string
        note?: string | null
        cover_bundle_id?: string | null
        parent_id?: string | null
      }
      version?: number
    }) => updateCollection(id, patch, version),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] })
      qc.invalidateQueries({ queryKey: ['collection-counts'] })
    },
  })
}

/** Persist a manual drag-reorder of one sibling group. Optimistic so the
 * dragged folder snaps to its new slot immediately in both the sidebar tree and
 * the main-browser grid (they share the ['collections'] cache); roll back on
 * error. */
export function useReorderCollections() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ parentId, orderedIds }: { parentId: string | null; orderedIds: string[] }) =>
      reorderCollections(parentId, orderedIds),
    onMutate: async ({ orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['collections'] })
      const prev = qc.getQueryData<CollectionRead[]>(['collections'])
      const orderById = new Map(orderedIds.map((id, i) => [id, i]))
      qc.setQueryData<CollectionRead[]>(['collections'], (old) =>
        old?.map((c) => (orderById.has(c.id) ? { ...c, sort_order: orderById.get(c.id)! } : c)),
      )
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['collections'], ctx.prev)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  })
}

/** "Clean up by… Title": rewrite every sibling group's manual order. */
export function useCleanupCollectionOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (order: 'asc' | 'desc') => cleanupCollectionOrder(order),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['collections'] }),
  })
}

/** Re-order the loaded browse items to match `orderedIds`, preserving each
 * infinite-query page's length (so the virtualizer's offsets stay valid). Items
 * not named keep their relative order at the tail. */
function reorderBrowsePages(
  data: InfiniteData<BundleBrowsePage>,
  orderedIds: string[],
): InfiniteData<BundleBrowsePage> {
  const all = data.pages.flatMap((p) => p.items as BundleSummary[])
  const byId = new Map(all.map((i) => [i.id, i]))
  const wanted = new Set(orderedIds)
  const ordered: BundleSummary[] = orderedIds.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
  for (const item of all) if (!wanted.has(item.id)) ordered.push(item)
  let idx = 0
  const pages = data.pages.map((p) => {
    const items = ordered.slice(idx, idx + p.items.length)
    idx += p.items.length
    return { ...p, items }
  })
  return { ...data, pages }
}

/** Persist a manual drag-reorder of bundles (MANUAL sort). Optimistically
 * re-orders every cached browse page so the dragged card holds its new slot,
 * then invalidates to reconcile with the server. */
export function useReorderBundles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      collectionId,
      orderedIds,
    }: {
      collectionId: string | null
      orderedIds: string[]
    }) => reorderBundles(collectionId, orderedIds),
    onMutate: async ({ orderedIds }) => {
      await qc.cancelQueries({ queryKey: ['browse'] })
      const snapshots = qc.getQueriesData<InfiniteData<BundleBrowsePage>>({ queryKey: ['browse'] })
      qc.setQueriesData<InfiniteData<BundleBrowsePage>>({ queryKey: ['browse'] }, (old) =>
        old ? reorderBrowsePages(old, orderedIds) : old,
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['browse'] }),
  })
}

/** "Clean up by…": rewrite the manual order of the whole scope to a chosen sort. */
export function useCleanupBundleOrder() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      collectionId,
      sort,
      order,
    }: {
      collectionId: string | null
      sort: CleanupSort
      order: SortOrder
    }) => cleanupBundleOrder(collectionId, sort, order),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['browse'] }),
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
      qc.invalidateQueries({ queryKey: ['bundle-tags'] })
      qc.invalidateQueries({ queryKey: ['bundle-collections'] })
    },
  })
}

function intersectAll(sets: string[][]): Set<string> {
  if (sets.length === 0) return new Set()
  let acc = new Set(sets[0])
  for (const ids of sets.slice(1)) {
    const next = new Set(ids)
    acc = new Set([...acc].filter((id) => next.has(id)))
  }
  return acc
}

/** Tag ids common to every one of `ids` — the multi-bundle inspector shows
 * these as already-assigned, mirroring the single-bundle editor. Reuses the
 * same query key as `useBundleTags` so the caches share entries. */
export function useCommonBundleTags(ids: string[]) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['bundle-tags', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBundleTags(id, signal),
    })),
  })
  const isLoading = results.some((r) => r.isLoading)
  const loaded = results
    .map((r) => r.data?.tag_ids)
    .filter((ids): ids is string[] => ids !== undefined)
  return { commonTagIds: intersectAll(loaded), isLoading }
}

/** Collection ids common to every one of `ids` — see `useCommonBundleTags`. */
export function useCommonBundleCollections(ids: string[]) {
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['bundle-collections', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchBundleCollections(id, signal),
    })),
  })
  const isLoading = results.some((r) => r.isLoading)
  const loaded = results
    .map((r) => r.data?.collection_ids)
    .filter((ids): ids is string[] => ids !== undefined)
  return { commonCollectionIds: intersectAll(loaded), isLoading }
}

/** Overwrite title and/or rating across every bundle in a multi-selection.
 * Fires one PATCH per bundle in parallel (there's no bulk endpoint for scalar
 * fields, only membership) with no If-Match — a bulk overwrite is an explicit,
 * one-shot action, and per-row versions aren't loaded in the browse grid. */
export function useBulkUpdateBundles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ ids, patch }: { ids: string[]; patch: BundlePatch }) =>
      Promise.all(ids.map((id) => updateBundle(id, patch))),
    onSuccess: (_data, { ids }) => {
      qc.invalidateQueries({ queryKey: ['browse'] })
      for (const id of ids) qc.invalidateQueries({ queryKey: ['bundle', id] })
    },
  })
}
