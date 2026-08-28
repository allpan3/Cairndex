import { useCallback } from 'react'

import {
  type InfiniteData,
  keepPreviousData,
  type QueryClient,
  type QueryKey,
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
  type BundleRead,
  type BundleSummary,
  type CleanupSort,
  type CollectionCounts,
  type CollectionCreate,
  type CollectionRead,
  type CollectionStats,
  type ConflictPolicy,
  type SortOrder,
  type FacetParams,
  type FilePatch,
  type FileRead,
  type FileRepairCandidate,
  type FileSelection,
  type FilterExpression,
  type GroupingPlan,
  type GroupingPlanSummary,
  type GroupingProposal,
  type GroupingStemLevelInput,
  type JobRead,
  type LibraryCreate,
  type LibraryRead,
  type LibraryRegister,
  type SmartCollectionCreate,
  type SmartCollectionUpdate,
  type TagCreate,
  type TagRead,
  type ViewCounts,
  addUnbundledFilesToBundle,
  batchUpdate,
  browseBundles,
  createBundleFromUnbundled,
  createCollection,
  createCollectionFromDirectory,
  fetchDirectoryBundleCount,
  createEmptyBundle,
  createLibrary,
  createTag,
  createTagGroup,
  deleteTag,
  deleteTagGroup,
  renameTagGroup,
  setTagGroupTags,
  updateTag,
  fetchUnbundledFiles,
  createSmartCollection,
  deleteBundle,
  deleteBundleWithFiles,
  forgetMissingFiles,
  deleteCollection,
  deleteLibrary,
  deleteSmartCollection,
  emptyTrash,
  applyGroupingPlan,
  approveDevicePairing,
  enqueueProbe,
  enqueueScan,
  enqueueStoryboards,
  enqueueThumbnails,
  fetchAuthStatus,
  fetchLibraryOwnership,
  startLibraryTakeover,
  fetchDevices,
  fetchActiveJobs,
  fetchJob,
  cancelJob,
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
  isNotFoundError,
  fetchBundleTags,
  fetchCollectionCounts,
  fetchFacets,
  fetchFileBrowserEntries,
  fetchFileRepairCandidate,
  fetchHealth,
  fetchLibraries,
  fetchPlaybackManifest,
  fetchContinueWatching,
  fetchSmartCollections,
  fetchTagCounts,
  fetchTagGroupTags,
  fetchTagGroups,
  fetchTags,
  fetchTrash,
  fetchViewCounts,
  importFile,
  makeDirectory,
  moveEntries,
  previewFilter,
  probeLibraryPath,
  registerLibrary,
  renameEntry,
  restoreTrashed,
  removeFile,
  repairFile,
  revokeDevice,
  renameGroupingProposal,
  setGroupingDirectoryStemLevel,
  setGroupingProposalDestination,
  setGroupingProposalKind,
  moveGroupingProposalFile,
  reparentGroupingProposal,
  renameCollection,
  updateCollection,
  reorderCollections,
  cleanupCollectionOrder,
  reorderBundles,
  cleanupBundleOrder,
  clearCoverFrame,
  reorderFiles,
  markBundleOpened,
  setBundleCollections,
  setBundleTags,
  setCoverFrame,
  setLibraryWriteMode,
  suggestBundleFromFiles,
  suggestTargetBundles,
  suggestUnbundledFilesForBundle,
  updateBundle,
  updateBundleCursor,
  updateFile,
  trashEntries,
  undoFileOperation,
  updateSmartCollection,
} from './client'
import {
  type MembershipChange,
  applyCountDeltas,
  collectionCountDeltas,
  directMembershipDeltas,
  emptyMembershipDelta,
  listingHoldsBundle,
  nextMembership,
} from './counts'
import { type ScanOutcome, scanOutcome } from '../app/scanSummary'

export type BrowseQuery = Omit<BrowseParams, 'offset'>

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

type JobProgressFn = (job: JobRead | null) => void

/** Merge optimistically hidden files back into their cached bundle positions. */
function restoreBundleFileSnapshots(
  qc: QueryClient,
  snapshots: [QueryKey, FileRead[] | undefined][],
  relativePaths: readonly string[],
) {
  const restoredPaths = new Set(relativePaths)
  for (const [key, previous] of snapshots) {
    if (!previous) continue
    qc.setQueryData<FileRead[]>(key, (current = []) => {
      const currentById = new Map(current.map((file) => [file.id, file]))
      const merged = previous.flatMap((file) => {
        const currentFile = currentById.get(file.id)
        if (currentFile) {
          currentById.delete(file.id)
          return [currentFile]
        }
        return restoredPaths.has(file.relative_path) ? [file] : []
      })
      return [...merged, ...currentById.values()]
    })
  }
}

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
async function watchOptionalJob(
  job: Promise<JobRead>,
  onProgress?: JobProgressFn,
  onSuccess?: () => void,
): Promise<void> {
  // A holder rather than a plain binding: the assignment happens inside the
  // callback, which control-flow analysis cannot see, so a `let` stays narrowed
  // to `null` and reading `.status` from it below is a type error.
  const latest: { job: JobRead | null } = { job: null }
  const track: JobProgressFn = (snapshot) => {
    if (snapshot !== null) latest.job = snapshot
    onProgress?.(snapshot)
  }
  try {
    await waitForJob(await job, track)
    onSuccess?.()
    onProgress?.(null)
  } catch {
    // waitForJob already emitted the terminal failed/cancelled snapshot, and a
    // *failure* should stay on screen: nobody asked for it and the message is
    // the only record of it. A cancellation is the opposite — it happened
    // because someone pressed stop, so leaving the row up reads as the stop not
    // having worked. The server agrees: a cancelled job is terminal and drops
    // straight out of the active list, so this local snapshot was the only
    // thing still holding it there.
    // An enqueue failure has no job row to preserve; clear the completed prior stage
    if (latest.job === null || latest.job.status === 'cancelled') onProgress?.(null)
  }
}

/**
 * Refresh what a collection's bundle count is shown as. The sidebar's
 * per-collection numbers and the inspector's own three figures are the same
 * fact at two altitudes, so nothing may refresh one and leave the other — the
 * inspector's used to go stale on every membership change because no
 * invalidation named it at all.
 */
function invalidateCollectionCounts(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['collection-counts'] })
  qc.invalidateQueries({ queryKey: ['collection-stats'] })
  // The collection rows themselves, because membership decides more than the
  // counts: a collection's auto-picked cover is the earliest thumbnailable
  // bundle in its subtree, and the tile is fetched with the row's `updated_at`
  // as its cache key. Without this the server's freshly moved key never reaches
  // the client and the browser keeps serving the old cover — or the folder
  // glyph it fell back to when there was nothing to show yet (owner,
  // 2026-07-30).
  qc.invalidateQueries({ queryKey: ['collections'] })
}

// Invalidate all library surfaces whose content changes after a maintenance job
function invalidateLibraryContent(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'browse',
    'view-counts',
    'collection-counts',
    'collection-stats',
    'tag-counts',
    'file-browser',
    'unbundled-files',
    'grouping-plans',
    'grouping-plan',
    'bundle',
    'bundle-files',
    'playback',
    'continue-watching',
  ])
    qc.invalidateQueries({ queryKey: [key] })
}

/** Refreshes surfaces whose displayed or playback facts come from ffprobe */
function invalidateProbeContent(qc: ReturnType<typeof useQueryClient>) {
  for (const key of ['bundle', 'bundle-files', 'browse', 'file-browser', 'playback']) {
    qc.invalidateQueries({ queryKey: [key] })
  }
}

// Drop active-library data while preserving registry and library-keyed auth state
export function resetLibraryContentQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.removeQueries({
    predicate: ({ queryKey }) => queryKey[0] !== 'libraries' && queryKey[0] !== 'auth-status',
  })
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

export function useContinueWatching(limit = 20, offset = 0, enabled = true) {
  return useQuery({
    queryKey: ['continue-watching', { limit, offset }],
    queryFn: ({ signal }) => fetchContinueWatching(limit, offset, signal),
    enabled,
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

// --- Libraries (registry) + File Browser ----------------------------------------
/** Lists registered libraries and optionally watches an all-offline registry for recovery. */
export function useLibraries({
  pollWhileUnavailable = false,
}: { pollWhileUnavailable?: boolean } = {}) {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: ({ signal }) => fetchLibraries(signal),
    // A removable drive or network mount can return without an app reload. Keep
    // the recovery loop limited to the otherwise-stranded state: once any
    // library is usable, ordinary focus/invalidation refreshes are sufficient
    refetchInterval: (query) => {
      const libraries = query.state.data
      return pollWhileUnavailable &&
        libraries !== undefined &&
        libraries.length > 0 &&
        libraries.every((library) => library.status === 'unavailable')
        ? 5000
        : false
    },
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
    // Classifies a typed path so the add flow can confirm one action instead of
    // making the owner choose between "create" and "register" up front. A
    // mutation rather than a query because it runs on submit, not on keystrokes.
    probe: useMutation({
      mutationFn: (path: string) => probeLibraryPath(path),
    }),
    // Metadata-only: deregisters the library and touches nothing on disk.
    remove: useMutation({
      mutationFn: (libraryId: string) => deleteLibrary(libraryId),
      onSuccess: (_result, libraryId) => {
        // Drop the row before refetching. The list is what resolves the active
        // library, so leaving the removed one in the cache for a round trip
        // would keep it active — and content queries, just cleared, would
        // immediately reload against a library this server no longer has.
        qc.setQueryData<LibraryRead[]>(['libraries'], (current) =>
          current?.filter((library) => library.id !== libraryId),
        )
        return invalidate()
      },
    }),
  }
}

// --- Library write mode (ADR-0013) -------------------------------------------
/**
 * The deployment's write-mode master switch, from `/health`.
 *
 * Server configuration, not user data: it cannot change while the app is open,
 * so it is fetched once and never refetched. `undefined` while it loads, which
 * the caller treats as "not allowed yet" — a toggle that flickers enabled
 * before the answer arrives is worse than one that arrives enabled.
 */
export function useDeploymentWriteMode() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    staleTime: Infinity,
  })
  return health.data?.write_mode === 'allowed'
}

/** Turn guarded file operations on or off for one library. */
export function useWriteModeMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      libraryId,
      enabled,
      passphrase,
    }: {
      libraryId: string
      enabled: boolean
      passphrase?: string
    }) => setLibraryWriteMode(libraryId, enabled, passphrase),
    onSuccess: (state, { libraryId }) => {
      // Patch the row rather than only invalidating: the listing is what the
      // manager renders from, and a refetch round trip would show the old
      // state for long enough to look like the click did nothing.
      qc.setQueryData<LibraryRead[]>(['libraries'], (current) =>
        current?.map((library) =>
          library.id === libraryId ? { ...library, write_mode_enabled: state.enabled } : library,
        ),
      )
      return qc.invalidateQueries({ queryKey: ['libraries'] })
    },
  })
}

// --- Guarded file operations (ADR-0013 W1) -----------------------------------
/**
 * Rename / New Folder / Undo, with the listing refreshed after each.
 *
 * Every mutation invalidates the File Browser rather than patching it: a rename
 * can change an entry's sort position, a collision policy can settle on a
 * different name than the one asked for, and a directory rename moves rows the
 * client never saw. The listing is cheap and the server is the authority on all
 * three.
 */
export function useFileOperations() {
  const qc = useQueryClient()
  const refresh = () => invalidateAfterFileOperation(qc)
  return {
    rename: useMutation({
      mutationFn: ({
        path,
        newName,
        onConflict,
      }: {
        path: string
        newName: string
        onConflict?: ConflictPolicy
      }) => renameEntry(path, newName, onConflict),
      onSuccess: refresh,
    }),
    mkdir: useMutation({
      mutationFn: (path: string) => makeDirectory(path),
      onSuccess: refresh,
    }),
    undo: useMutation({
      mutationFn: (operationId: string) => undoFileOperation(operationId),
      onSuccess: refresh,
    }),
    trash: useMutation({
      mutationFn: (paths: string[]) => trashEntries(paths),
      // A NAS can take seconds to settle the journaled move. Active bundle
      // surfaces should reflect the owner's intent while that safe operation
      // runs, then restore the rows if the server rejects it.
      onMutate: async (paths: string[]) => {
        const query = { queryKey: ['bundle-files'] }
        await qc.cancelQueries(query)
        const previous = qc.getQueriesData<FileRead[]>(query)
        const requested = new Set(paths)
        qc.setQueriesData<FileRead[]>(query, (files) =>
          files?.filter((file) => !requested.has(file.relative_path)),
        )
        return { previous }
      },
      onError: (_error, _paths, context) => {
        restoreBundleFileSnapshots(qc, context?.previous ?? [], _paths)
      },
      onSuccess: (result, _paths, context) => {
        restoreBundleFileSnapshots(qc, context?.previous ?? [], result.failed_paths)
        refresh()
      },
    }),
    move: useMutation({
      mutationFn: ({
        paths,
        destDir,
        onConflict,
      }: {
        paths: string[]
        destDir: string
        onConflict?: ConflictPolicy
      }) => moveEntries(paths, destDir, onConflict),
      onSuccess: refresh,
    }),
    // One mutation per file rather than per batch: each import gets its own
    // collision answer and its own undo, which is only possible if each is its
    // own request (see the server's `import_stream`).
    importOne: useMutation({
      mutationFn: ({
        file,
        destDir,
        onConflict,
        signal,
      }: {
        file: File
        destDir: string
        onConflict?: ConflictPolicy
        signal?: AbortSignal
        // No `link`: an imported file is copied into the folder, not fast-added
        // into a one-file bundle. It shows in the File Browser; bundling stays a
        // separate, deliberate action.
      }) => importFile(file, { destDir, onConflict, signal }),
      onSuccess: refresh,
    }),
  }
}

// Everything a file operation can change: the listing it happened in, the views
// that render paths or counts, the journal, and the trash.
export function invalidateAfterFileOperation(qc: ReturnType<typeof useQueryClient>) {
  for (const key of [
    'file-browser',
    'browse',
    'view-counts',
    'collection-counts',
    'collection-stats',
    'tag-counts',
    'collections',
    'bundle',
    'bundle-files',
    'playback',
    'continue-watching',
    'unbundled-files',
    'file-ops',
    'trash',
  ])
    qc.invalidateQueries({ queryKey: [key] })
}

/** Everything currently recoverable from this library's trash. */
export function useTrash(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ['trash'],
    queryFn: ({ signal }) => fetchTrash(signal),
    enabled: options?.enabled ?? true,
  })
}

/**
 * Put one deletion back.
 *
 * Invalidates the same surfaces a delete does, because a restore is a delete
 * running backwards: the files reappear in the File Browser, their rows go back
 * to `available`, and any bundle they belong to is whole again.
 */
export function useRestoreFromTrash() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (operationId: string) => restoreTrashed(operationId),
    onSuccess: () => invalidateAfterFileOperation(qc),
  })
}

/** Empty the trash for good. */
export function useEmptyTrash() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (olderThanDays?: number) => emptyTrash(olderThanDays),
    onSuccess: () => invalidateAfterFileOperation(qc),
  })
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

/**
 * Whether this server may serve the library (ADR-0018).
 *
 * Gates the workspace mount rather than reacting to 409s from content queries:
 * a lease refusal would otherwise surface once per query, as a scatter of
 * identical errors, instead of one explainable state. Polls only while a
 * takeover is running — the observation window is minutes long by design.
 */
export function useLibraryOwnership(libraryId: string | null) {
  return useQuery({
    queryKey: ['library-ownership', libraryId],
    queryFn: ({ signal }) => fetchLibraryOwnership(libraryId!, signal),
    enabled: libraryId !== null,
    refetchInterval: (query) => (query.state.data?.takeover?.running ? 2000 : false),
  })
}

export function useStartTakeover(libraryId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => startLibraryTakeover(libraryId!),
    onSuccess: (ownership) => {
      // Seed the polling query with the 202 response so the dialog shows
      // "running" immediately rather than after the next poll.
      qc.setQueryData(['library-ownership', libraryId], ownership)
    },
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

/** Paired devices refresh locally, with short polling only while awaiting token delivery. */
export function useDevices(awaitingDevice = false, previousCount: number | null = null) {
  return useQuery({
    queryKey: ['devices'],
    queryFn: ({ signal }) => fetchDevices(signal),
    refetchInterval: (query) =>
      awaitingDevice && previousCount !== null && (query.state.data?.length ?? 0) <= previousCount
        ? 1000
        : false,
  })
}

export function useDeviceMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['devices'] })
  return {
    approve: useMutation({
      mutationFn: ({ pairCode, libraryIds }: { pairCode: string; libraryIds: string[] }) =>
        approveDevicePairing(pairCode, libraryIds),
      onSuccess: invalidate,
    }),
    revoke: useMutation({
      mutationFn: (deviceId: string) => revokeDevice(deviceId),
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

/** Jobs already running or queued for the active library.
 *
 * Job progress otherwise lives only inside the mutation that started the job,
 * so reloading the page lost track of work that was still going — the owner
 * reported returning to a vanished scan indicator while the scan ran on
 * (2026-07-30). The queue is server state, so a fresh page can pick it up.
 *
 * Polls only while something is active: an idle library asks once on mount and
 * then not again until a mutation invalidates this key.
 */
export function useActiveJobs(libraryId: string | null) {
  return useQuery({
    queryKey: ['active-jobs', libraryId],
    queryFn: ({ signal }) => fetchActiveJobs(libraryId!, signal),
    enabled: libraryId !== null,
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? 1000 : false),
    // A settled job should disappear promptly rather than linger for a refetch.
    refetchOnWindowFocus: true,
  })
}

/** Ask one job to stop, and reflect it in the sidebar without waiting for a poll.
 *
 * The optimistic write is what makes the button feel like it did something: a
 * running job takes until its next checkpoint to actually stop, and until the
 * next poll lands the row would otherwise look untouched.
 */
export function useCancelJob() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (jobId: string) => cancelJob(jobId),
    onMutate: async (jobId: string) => {
      await qc.cancelQueries({ queryKey: ['active-jobs'] })
      qc.setQueriesData<JobRead[]>({ queryKey: ['active-jobs'] }, (rows) =>
        Array.isArray(rows)
          ? rows.map((job) => (job.id === jobId ? { ...job, cancel_requested: true } : job))
          : rows,
      )
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['active-jobs'] })
    },
  })
}

/** Callbacks shared by the scan and combined Update maintenance flows */
interface MaintenanceOptions {
  onGroupingPlan?: (planId: string) => void
  onScanComplete?: (outcome: ScanOutcome) => void
  // Receives each polled job snapshot (and null when the run settles) so the
  // sidebar can render a live progress bar with phase/message.
  onProgress?: JobProgressFn
}

/** Runs metadata then storyboard work without holding the grouping-review mutation open */
function watchPostScanJobs(
  qc: ReturnType<typeof useQueryClient>,
  options: MaintenanceOptions,
  libraryId: string,
): void {
  void watchOptionalJob(enqueueProbe(libraryId), options.onProgress, () => {
    invalidateProbeContent(qc)
    // Storyboard eligibility and sampling need the duration populated by probe
    void watchOptionalJob(enqueueStoryboards(libraryId), options.onProgress, () =>
      qc.invalidateQueries({ queryKey: ['playback'] }),
    )
  })
}

/** Enqueue discovery/repair on its own — no grouping pass, no review dialog.
 *
 * "Scan new files" sits in the same menu as "Suggest grouping", so it must not
 * do that item's work: the owner asked for a scan and got the grouping review
 * dialog on top of it (2026-08-15). `notifyGroupingPlan` is deliberately absent
 * here; a scan-only job reports no plan for it to open.
 */
export function useScan(options: MaintenanceOptions = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const scanJob = await waitForJob(
        await enqueueScan({ suggestGrouping: false }),
        options.onProgress,
      )
      options.onScanComplete?.(scanOutcome(scanJob))
      return scanJob
    },
    onSuccess: () => invalidateLibraryContent(qc),
    onSettled: () => options.onProgress?.(null),
  })
}

/** Index a library that has just been created, without being asked twice.
 *
 * A folder that has only now become a library has no rows at all, so every
 * surface is empty and playback has no metadata to decide from — and the cure
 * was two menu items the owner had to know to find (owner-reported,
 * 2026-08-15). Discovery then metadata, both scoped to the new library rather
 * than the active one, because the switch may not have settled yet.
 *
 * Deliberately *not* the full Update: no grouping pass, so the review dialog
 * does not open over a library the owner has only just added, and no
 * storyboards, which are the expensive one and remain a deliberate action.
 */
export function useIndexNewLibrary() {
  const qc = useQueryClient()
  // Progress is not threaded through a callback here as it is for the sidebar's
  // own maintenance actions: this runs from the library dialog, which is a
  // level above the sidebar and does not own its job indicator. Nudging the
  // active-jobs query instead lets the sidebar find the work server-side and
  // report it exactly as it reports a scan the owner started.
  const showInSidebar = () => qc.invalidateQueries({ queryKey: ['active-jobs'] })
  return useMutation({
    mutationFn: async (libraryId: string) => {
      const scan = await enqueueScan({ suggestGrouping: false, libraryId })
      void showInSidebar()
      await waitForJob(scan)
      invalidateLibraryContent(qc)
      const probe = await enqueueProbe(libraryId)
      void showInSidebar()
      await waitForJob(probe)
      invalidateProbeContent(qc)
    },
    // A failure here is reported by the job row itself, and must not take the
    // add flow down with it — the library is registered either way.
    onSettled: showInSidebar,
  })
}

/** Enqueue scan/grouping, then hand metadata and storyboards to background progress */
export function useUpdateLibrary(options: MaintenanceOptions = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      const scanJob = await waitForJob(await enqueueScan(), options.onProgress)
      options.onScanComplete?.(scanOutcome(scanJob))
      return scanJob
    },
    onSuccess: (job) => {
      invalidateLibraryContent(qc)
      notifyGroupingPlan(job, options.onGroupingPlan)
      watchPostScanJobs(qc, options, job.library_id)
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
    onSuccess: () => invalidateProbeContent(qc),
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

/** Generate missing/stale storyboard indexes and sheets for eligible videos */
export function useStoryboards(options: { onProgress?: JobProgressFn } = {}) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => waitForJob(await enqueueStoryboards(), options.onProgress),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['playback'] }),
    onSettled: () => options.onProgress?.(null),
  })
}

// --- Grouping plans (ADR-0009) -----------------------------------------------

/** Replace edited grouping proposals without refetching the whole plan. */
function updateGroupingProposals(
  qc: QueryClient,
  planId: string | null,
  updated: GroupingProposal[],
) {
  const byId = new Map(updated.map((proposal) => [proposal.id, proposal]))
  qc.setQueryData<GroupingPlan>(['grouping-plan', planId], (current) =>
    current
      ? {
          ...current,
          proposals: current.proposals.map((proposal) => byId.get(proposal.id) ?? proposal),
        }
      : current,
  )
}

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
    mutationFn: (stemLevels?: GroupingStemLevelInput) => generateGroupingPlan(stemLevels),
    onSuccess: (generated) => {
      qc.setQueryData<GroupingPlan>(['grouping-plan', generated.id], generated)
      qc.setQueryData<GroupingPlanSummary[]>(['grouping-plans'], (current) => [
        {
          id: generated.id,
          status: generated.status,
          rule_version: generated.rule_version,
          generated_at: generated.generated_at,
          applied_at: generated.applied_at,
          proposal_count: generated.proposals.length,
        },
        ...(current ?? [])
          .filter((plan) => plan.id !== generated.id)
          .map((plan) =>
            plan.status === 'open' ? { ...plan, status: 'superseded' as const } : plan,
          ),
      ])
      qc.invalidateQueries({ queryKey: ['grouping-plans'] })
    },
  })
}

/** Persist an inline rename and update the open plan in-place. */
export function useRenameGroupingProposal(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ proposalId, title }: { proposalId: string; title: string }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return renameGroupingProposal(planId, proposalId, title)
    },
    onSuccess: (updated) =>
      qc.setQueryData<GroupingPlan>(['grouping-plan', planId], (current) =>
        current
          ? {
              ...current,
              proposals: current.proposals.map((proposal) =>
                proposal.id === updated.id ? updated : proposal,
              ),
            }
          : current,
      ),
  })
}

/** Persist a reversible existing-versus-new bundle destination. */
export function useSetGroupingProposalDestination(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      proposalId,
      createNewBundle,
    }: {
      proposalId: string
      createNewBundle: boolean
    }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return setGroupingProposalDestination(planId, proposalId, createNewBundle)
    },
    onSuccess: (updated) => updateGroupingProposals(qc, planId, [updated]),
  })
}

/** Move one reviewed file and update every affected proposal in-place. */
export function useMoveGroupingProposalFile(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      sourceProposalId,
      assetFileId,
      targetProposalId,
      targetIndex,
    }: {
      sourceProposalId: string
      assetFileId: string
      targetProposalId: string
      targetIndex: number
    }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return moveGroupingProposalFile(
        planId,
        sourceProposalId,
        assetFileId,
        targetProposalId,
        targetIndex,
      )
    },
    onSuccess: (updated) => updateGroupingProposals(qc, planId, updated),
  })
}

/** Reparent reviewed bundle or new collection work in the open plan */
export function useReparentGroupingProposal(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      proposalId,
      parentProposalId,
      targetCollectionId,
    }: {
      proposalId: string
      parentProposalId: string | null
      targetCollectionId: string | null
    }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return reparentGroupingProposal(planId, proposalId, parentProposalId, targetCollectionId)
    },
    // A persisted destination can materialize or prune structural context rows
    onSuccess: (plan) => qc.setQueryData<GroupingPlan>(['grouping-plan', planId], plan),
  })
}

export function useSetGroupingStemLevel(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ directory, level }: { directory: string; level: number }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return setGroupingDirectoryStemLevel(planId, directory, level)
    },
    // The plan id is unchanged and only one directory's rows were replaced, so
    // the response is the new truth for the whole plan cache entry.
    onSuccess: (plan) => qc.setQueryData<GroupingPlan>(['grouping-plan', planId], plan),
  })
}

export function useSetGroupingProposalKind(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ proposalId, kind }: { proposalId: string; kind: 'bundle' | 'container' }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return setGroupingProposalKind(planId, proposalId, kind)
    },
    // The whole plan is replaced rather than patched proposal-by-proposal: a
    // conversion creates or deletes children, so there is no id-wise mapping
    // from the old tree to the new one.
    onSuccess: (plan) => qc.setQueryData<GroupingPlan>(['grouping-plan', planId], plan),
  })
}

export function useApplyGroupingPlan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, proposalIds }: { id: string; proposalIds?: string[] }) =>
      applyGroupingPlan(id, proposalIds),
    onSuccess: () => {
      // Applying confirms bundles and may create collections + subtitle links —
      // so files leave Unbundled and the File Browser badges change.
      for (const key of [
        'browse',
        'view-counts',
        'collections',
        'collection-counts',
        'collection-stats',
        'unbundled-files',
        'file-browser',
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
export function useFileBrowser(path: string | null, enabled = true, keepPrevious = false) {
  return useQuery({
    queryKey: ['file-browser', path ?? ''],
    queryFn: ({ signal }) => fetchFileBrowserEntries(path, signal),
    enabled,
    // Opt-in, for pickers: stepping into a folder is a *new* query key with
    // nothing cached, so the list is replaced by "Loading…" and the dialog
    // visibly flashes on every click (owner, 2026-08-26). Holding the previous
    // listing keeps the box steady.
    //
    // A caller that opts in **must** dim and disable the rows while
    // `isPlaceholderData` is true. What is on screen then belongs to the folder
    // you just left while the breadcrumb already reads the new one, so a click
    // landing on a stale row would navigate somewhere that may not exist —
    // trading a cosmetic flash for a real misnavigation.
    ...(keepPrevious ? { placeholderData: keepPreviousData } : {}),
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

/**
 * Create a tag from a typed name, reading `/` as a hierarchy divider: `a/b/c`
 * creates (or reuses) `a`, then `b` under it, then `c` under that, and resolves
 * to the leaf. A name without a slash behaves exactly like `useCreateTag`.
 *
 * Existing segments are matched case-insensitively against `existing` — the tag
 * list the caller is already rendering from — so typing a parent that exists
 * nests under it rather than erroring on the sibling-name constraint.
 *
 * `parentId` roots the path somewhere other than the top level, which is what
 * "New Child Tag" on the All Tags page needs; the slash still nests from there.
 */
export function useCreateTagPath() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({
      path,
      existing,
      parentId: startParentId = null,
    }: {
      path: string
      existing: TagRead[]
      /** Create beneath this tag instead of at the top level. */
      parentId?: string | null
    }): Promise<TagRead> => {
      const segments = path
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
      if (segments.length === 0) throw new Error('tag name must not be empty')
      const known = [...existing]
      let parentId: string | null = startParentId
      let leaf: TagRead | null = null
      for (const name of segments) {
        const found = known.find(
          (tag) =>
            (tag.parent_id ?? null) === parentId && tag.name.toLowerCase() === name.toLowerCase(),
        )
        if (found) {
          leaf = found
        } else {
          leaf = await createTag({ name, parent_id: parentId })
          known.push(leaf)
        }
        parentId = leaf.id
      }
      return leaf as TagRead
    },
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
      mutationFn: ({ id, cascade }: { id: string; cascade?: boolean }) =>
        deleteTag(id, cascade ?? false),
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

/** Create/rename/delete tag groups, and move a tag in or out of one.
 *
 * The server replaces a group's membership wholesale (there is no add/remove
 * verb), so `addTag`/`removeTag` read the group's current members from the
 * `tag-group-memberships` cache the page already renders from and send the
 * amended list. A group whose membership has not been fetched yet is read from
 * the network first rather than assumed empty — sending a short list would
 * silently drop every other tag in the group. */
export function useTagGroupMutations() {
  const qc = useQueryClient()
  // Group membership changes what the All Tags panels and the picker's group
  // tabs list; the tags themselves and their counts are untouched.
  const invalidate = () => {
    for (const key of ['tag-groups', 'tag-group-memberships'])
      qc.invalidateQueries({ queryKey: [key] })
  }
  const membersOf = async (groupId: string): Promise<string[]> => {
    const cached = qc
      .getQueriesData<Record<string, string[]>>({ queryKey: ['tag-group-memberships'] })
      .map(([, data]) => data?.[groupId])
      .find((ids) => ids !== undefined)
    return cached ?? (await fetchTagGroupTags(groupId))
  }
  return {
    create: useMutation({
      mutationFn: (name: string) => createTagGroup(name),
      onSuccess: invalidate,
    }),
    rename: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) => renameTagGroup(id, name),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => deleteTagGroup(id),
      onSuccess: invalidate,
    }),
    addTag: useMutation({
      mutationFn: async ({ groupId, tagId }: { groupId: string; tagId: string }) => {
        const current = await membersOf(groupId)
        if (current.includes(tagId)) return
        await setTagGroupTags(groupId, [...current, tagId])
      },
      onSuccess: invalidate,
    }),
    removeTag: useMutation({
      mutationFn: async ({ groupId, tagId }: { groupId: string; tagId: string }) => {
        const current = await membersOf(groupId)
        if (!current.includes(tagId)) return
        await setTagGroupTags(
          groupId,
          current.filter((id) => id !== tagId),
        )
      },
      onSuccess: invalidate,
    }),
  }
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

/** Resolve a request for something that may have been deleted.
 *
 * A 404 here is not a fault: a bundle can be forgotten, swept by a scan, or
 * deleted in another window while a pane still points at it. Returning `absent`
 * rather than throwing lets each surface say "gone" instead of showing its
 * last-known state, which is what the inspector was doing — a deleted bundle
 * kept its whole panel, missing badge and all (owner, 2026-08-24). It also stops
 * react-query retrying a 404 three times over.
 */
async function orAbsent<T, A>(load: Promise<T>, absent: A): Promise<T | A> {
  try {
    return await load
  } catch (error) {
    if (isNotFoundError(error)) return absent
    throw error
  }
}

export function useBundle(id: string | null) {
  return useQuery({
    queryKey: ['bundle', id],
    // `null` means gone, `undefined` means not loaded yet — the two readings the
    // inspector needs to keep apart.
    queryFn: ({ signal }) => orAbsent(fetchBundle(id as string, signal), null),
    enabled: id !== null,
  })
}

export function useBundleFiles(id: string | null) {
  return useQuery({
    queryKey: ['bundle-files', id],
    queryFn: ({ signal }) => orAbsent(fetchBundleFiles(id as string, signal), []),
    enabled: id !== null,
  })
}

export function useFileRepairCandidate(bundleId: string, fileId: string, enabled: boolean) {
  return useQuery<FileRepairCandidate | null>({
    queryKey: ['file-repair-candidate', bundleId, fileId],
    queryFn: ({ signal }) => fetchFileRepairCandidate(bundleId, fileId, signal),
    enabled,
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

// --- Optimistic sidebar counts ------------------------------------------------
// Filing a bundle is a metadata write with a fully predictable outcome, so the
// numbers beside the collections move with the drop rather than one round trip
// later — on a library whose database sits on a network share, that round trip
// is plainly visible. `counts.ts` owns the arithmetic; the helpers here read the
// caches it needs, write the result, and hand back what to put back on failure.

/** A cache entry captured before an optimistic write, for rollback on error. */
type CacheSnapshot = [readonly unknown[], unknown]

/** Undo optimistic writes. Newest first, so a key captured twice in one mutation
 *  (view counts move for both collections and tags) ends on its original value. */
function restoreSnapshots(qc: QueryClient, snapshots: CacheSnapshot[] | undefined) {
  for (const [key, data] of [...(snapshots ?? [])].reverse()) qc.setQueryData(key, data)
}

type MembershipEntry = { bundle_id: string; collection_ids?: string[]; tag_ids?: string[] }

/** The two membership axes that feed counts, and where each lives in the cache. */
const MEMBERSHIP_AXES = {
  collections: {
    key: 'bundle-collections',
    read: (entry: MembershipEntry) => entry.collection_ids,
    write: (entry: MembershipEntry, ids: string[]): MembershipEntry => ({
      ...entry,
      collection_ids: ids,
    }),
  },
  tags: {
    key: 'bundle-tags',
    read: (entry: MembershipEntry) => entry.tag_ids,
    write: (entry: MembershipEntry, ids: string[]): MembershipEntry => ({ ...entry, tag_ids: ids }),
  },
} as const

type MembershipAxis = keyof typeof MEMBERSHIP_AXES

/**
 * The one system view per axis whose *membership* decides what it lists, and so
 * the only unscoped view a membership write can move a bundle in or out of. All,
 * Recent, Missing, Unbundled and Random list the same bundles either way.
 */
const MEMBERSHIP_VIEWS: Record<MembershipAxis, string> = {
  collections: 'uncategorized',
  tags: 'untagged',
}

/**
 * The outcome of projecting a membership write onto the cached browse listings:
 * the rewrites to roll back if the write fails, and the keys of the listings the
 * projection could *not* bring up to date.
 *
 * The second half is what keeps a drop honest. Invalidation alone is not enough:
 * React Query serves a stale query's cached data the instant it is observed and
 * refetches behind it, so a listing the projection quietly skipped is a listing
 * the owner opens and sees the pre-drop contents of — while the count beside it
 * moved immediately. Naming those listings lets the settle step drop them
 * instead of hoping.
 */
interface ListingProjection {
  snapshots: CacheSnapshot[]
  unproven: QueryKey[]
}

/**
 * Every cached browse listing a write on this axis could have changed the
 * contents of: the collection-scoped grids, plus the axis's own system view.
 * Browse has no tag scope — a tag is a filter, not a scope — so a tag write
 * reaches only Untagged.
 *
 * Used as the projection's fallback: when it has nothing to work from, every one
 * of these is unproven rather than none of them.
 */
function membershipDependentListings(qc: QueryClient, axis: MembershipAxis): QueryKey[] {
  const keys: QueryKey[] = []
  for (const [key, data] of qc.getQueriesData<InfiniteData<BundleBrowsePage>>({
    queryKey: ['browse'],
  })) {
    if (!data) continue
    const scope = key[1] as BrowseQuery | undefined
    const scoped = axis === 'collections' && Boolean(scope?.collectionId)
    if (scoped || scope?.view === MEMBERSHIP_VIEWS[axis]) keys.push(key)
  }
  return keys
}

/**
 * Reconcile the listings a projection could not prove: drop the ones nobody is
 * watching, refetch the one on screen.
 *
 * Dropping is the whole point — see `ListingProjection`. It costs a fetch the
 * next time that view is opened, which after ADR-0022 is a local metadata query,
 * and in exchange no listing can be shown disagreeing with its own count. An
 * active listing is kept and refetched in place instead: blanking the grid the
 * owner is looking at is worse than a beat of stale rows under a refetch.
 */
function reconcileUnprovenListings(qc: QueryClient, unproven: readonly QueryKey[] | undefined) {
  for (const key of unproven ?? []) {
    qc.removeQueries({ queryKey: key, exact: true, type: 'inactive' })
    qc.invalidateQueries({ queryKey: key, exact: true })
  }
}

/**
 * Each bundle's membership before the write, and the set it will hold after —
 * with the after-set written into the cache so the inspector's chips move at the
 * same moment as the counts (and so a second drag computes its delta from the
 * first one's result rather than from a stale membership).
 *
 * Returns null when *any* bundle's membership is unknown: the arithmetic needs
 * the whole membership to know which ancestors a bundle already counts toward,
 * and a partial guess would put a number on screen that is neither the old count
 * nor the new one. Callers then leave the counts to the invalidation. Drag start
 * warms this cache (`prefetchBundleMemberships`) so the common gesture has it.
 */
function projectMemberships(
  qc: QueryClient,
  axis: MembershipAxis,
  bundleIds: readonly string[],
  add: readonly string[],
  remove: readonly string[],
): { changes: MembershipChange[]; snapshots: CacheSnapshot[] } | null {
  if (add.length === 0 && remove.length === 0) return { changes: [], snapshots: [] }
  const { key, read, write } = MEMBERSHIP_AXES[axis]
  const changes: MembershipChange[] = []
  const snapshots: CacheSnapshot[] = []
  for (const bundleId of bundleIds) {
    const queryKey = [key, bundleId]
    const cached = qc.getQueryData<MembershipEntry>(queryKey)
    const before = cached === undefined ? undefined : read(cached)
    if (cached === undefined || before === undefined) return null
    const after = nextMembership(before, add, remove)
    changes.push({ before, after })
    snapshots.push([queryKey, cached])
    qc.setQueryData<MembershipEntry>(queryKey, write(cached, after))
  }
  return { changes, snapshots }
}

/** The moved bundles' summary rows, found in whatever listing already holds
 *  them — the grid they were dragged from, most often. A bundle with no cached
 *  row cannot be drawn into a listing it is arriving in, so it is left to the
 *  refetch. */
function cachedSummaries(
  qc: QueryClient,
  bundleIds: readonly string[],
): Map<string, BundleSummary> {
  const wanted = new Set(bundleIds)
  const found = new Map<string, BundleSummary>()
  for (const [, data] of qc.getQueriesData<InfiniteData<BundleBrowsePage>>({
    queryKey: ['browse'],
  })) {
    for (const page of data?.pages ?? []) {
      for (const item of page.items) {
        if (wanted.has(item.id) && !found.has(item.id)) found.set(item.id, item)
      }
    }
  }
  return found
}

/**
 * Bring every cached collection-scoped listing in line with these membership
 * changes — both the bundles that just left it and the ones that just arrived.
 *
 * Only the leaving half existed before, and the missing half is what the owner
 * saw: file a bundle into a collection, open it, and the grid renders the
 * cached listing from last time — which does not contain the bundle — while the
 * refetch is still in flight. The count beside it had already moved, so the two
 * disagreed until the round trip landed, and on a library whose database sits
 * on a network share that is long enough to read as "there's nothing in here"
 * (owner, 2026-07-30). A collection opened for the first time was never
 * affected: with nothing cached there is nothing stale to show.
 *
 * A listing this cannot work out is not left alone to be served stale — its key
 * goes into `unproven` for the settle step to drop. That covers a listing
 * carrying a filter or a search (whether a bundle belongs in one is the server's
 * judgement, not something membership alone answers), an arrival with no cached
 * summary row to draw, and — via `changes` being null — a write whose
 * memberships were never loaded.
 */
function projectCollectionListings(
  qc: QueryClient,
  bundleIds: readonly string[],
  changes: MembershipChange[] | null,
): ListingProjection {
  // An empty change set is not an unknown one: this axis did not move, so every
  // listing is provably exactly as it was.
  if (changes !== null && changes.length === 0) return { snapshots: [], unproven: [] }
  const collections = qc.getQueryData<CollectionRead[]>(['collections'])
  // Unknown memberships, or no collection tree to answer "does this listing show
  // its descendants' contents" with — either way there is nothing to project
  // from, and a wrong guess would put a card in the wrong grid.
  if (changes === null || collections === undefined) {
    return { snapshots: [], unproven: membershipDependentListings(qc, 'collections') }
  }
  const summaries = cachedSummaries(qc, bundleIds)
  const snapshots: CacheSnapshot[] = []
  const unproven: QueryKey[] = []

  for (const [key, data] of qc.getQueriesData<InfiniteData<BundleBrowsePage>>({
    queryKey: ['browse'],
  })) {
    if (!data) continue
    const scope = key[1] as BrowseQuery | undefined
    const scopeId = scope?.collectionId
    if (!scopeId) {
      // Uncategorized lists exactly the bundles in no collection at all, which
      // this write may have emptied or filled; no other unscoped view moves.
      if (scope?.view === MEMBERSHIP_VIEWS.collections) unproven.push(key)
      continue
    }
    if (scope.filter || scope.search?.trim()) {
      unproven.push(key)
      continue
    }

    const held = (memberships: readonly string[]) =>
      listingHoldsBundle(collections, scopeId, scope.includeDescendants ?? false, memberships)
    const leaving = new Set<string>()
    const arriving: BundleSummary[] = []
    bundleIds.forEach((bundleId, index) => {
      const change = changes[index]
      if (!change) return
      const before = held(change.before)
      const after = held(change.after)
      if (before && !after) leaving.add(bundleId)
      if (!before && after) {
        const summary = summaries.get(bundleId)
        if (summary) arriving.push(summary)
        // No cached row to draw the arrival with. This is the silent failure the
        // owner kept hitting: the listing would keep its pre-drop contents, the
        // count beside it would move, and nothing would say the two disagreed.
        else unproven.push(key)
      }
    })
    if (leaving.size === 0 && arriving.length === 0) continue

    const present = new Set(data.pages.flatMap((page) => page.items.map((item) => item.id)))
    const fresh = arriving.filter((summary) => !present.has(summary.id))
    let departed = 0
    const pages = data.pages.map((page, index) => {
      const kept = page.items.filter((item) => !leaving.has(item.id))
      departed += page.items.length - kept.length
      // Arrivals go to the head of the first page. Their true position depends
      // on the listing's sort — and under a manual order a new membership sorts
      // first anyway — so this is a placement, not a claim; the refetch settles
      // it either way. Anywhere else and a card would appear mid-grid, which
      // reads as something moving rather than something arriving.
      return { ...page, items: index === 0 ? [...fresh, ...kept] : kept }
    })
    const delta = fresh.length - departed
    snapshots.push([key, data])
    qc.setQueryData<InfiniteData<BundleBrowsePage>>(key, {
      ...data,
      // `total` is the size of the whole result set repeated on every page, so
      // it moves by the same amount on each. It used to be decremented by the
      // whole batch regardless of how many of them that listing actually held.
      pages: pages.map((page) => ({ ...page, total: Math.max(0, page.total + delta) })),
    })
  }
  return { snapshots, unproven }
}

/** Move the sidebar's per-collection counts, the open collection inspector's own
 *  figures, and the Uncategorized view count by what these membership changes
 *  imply. */
function applyCollectionCounts(qc: QueryClient, changes: MembershipChange[]): CacheSnapshot[] {
  const collections = qc.getQueryData<CollectionRead[]>(['collections'])
  // Without the tree there are no ancestors to walk, and every delta would land
  // on the dropped-on collection alone — the flat ±1 this exists to avoid.
  if (changes.length === 0 || collections === undefined) return []
  const snapshots: CacheSnapshot[] = []
  const subtree = collectionCountDeltas(collections, changes)
  const direct = directMembershipDeltas(changes)
  // Both maps move, because the sidebar shows whichever one matches the grid it
  // sits beside and either may be on screen. Filing into a subcollection moves
  // only the parent's subtree figure, which is precisely the case where showing
  // one number for the other read as a count that refused to update.
  const counts = qc.getQueryData<CollectionCounts>(['collection-counts'])
  if (counts) {
    snapshots.push([['collection-counts'], counts])
    qc.setQueryData<CollectionCounts>(['collection-counts'], {
      subtree: applyCountDeltas(counts.subtree, subtree),
      direct: applyCountDeltas(counts.direct, direct),
    })
  }
  // The inspector shows the same collection's numbers beside the sidebar's, so
  // they move together: its subtree total is the count above, and its "directly
  // in this collection" figure is plain membership.
  for (const [key, stats] of qc.getQueriesData<CollectionStats>({
    queryKey: ['collection-stats'],
  })) {
    const id = key[1]
    if (typeof id !== 'string' || !stats) continue
    const totalDelta = subtree.get(id) ?? 0
    const directDelta = direct.get(id) ?? 0
    if (totalDelta === 0 && directDelta === 0) continue
    snapshots.push([key, stats])
    qc.setQueryData<CollectionStats>(key, {
      ...stats,
      total_bundles: Math.max(0, stats.total_bundles + totalDelta),
      direct_bundles: Math.max(0, stats.direct_bundles + directDelta),
    })
  }
  // A bundle is Uncategorized exactly while it is in no collection at all.
  snapshots.push(...applyViewCountDelta(qc, 'uncategorized', emptyMembershipDelta(changes)))
  return snapshots
}

/** The same for tags: per-tag counts are direct membership, plus Untagged. */
function applyTagCounts(qc: QueryClient, changes: MembershipChange[]): CacheSnapshot[] {
  if (changes.length === 0) return []
  const snapshots: CacheSnapshot[] = []
  const counts = qc.getQueryData<Record<string, number>>(['tag-counts'])
  if (counts) {
    snapshots.push([['tag-counts'], counts])
    qc.setQueryData(['tag-counts'], applyCountDeltas(counts, directMembershipDeltas(changes)))
  }
  snapshots.push(...applyViewCountDelta(qc, 'untagged', emptyMembershipDelta(changes)))
  return snapshots
}

function applyViewCountDelta(
  qc: QueryClient,
  view: 'uncategorized' | 'untagged',
  delta: number,
): CacheSnapshot[] {
  const counts = qc.getQueryData<ViewCounts>(['view-counts'])
  if (!counts || delta === 0) return []
  qc.setQueryData<ViewCounts>(['view-counts'], {
    ...counts,
    [view]: Math.max(0, counts[view] + delta),
  })
  return [[['view-counts'], counts]]
}

/** Beyond this many bundles a drag stops warming memberships — see below. */
const MEMBERSHIP_PREFETCH_LIMIT = 50

/**
 * Warm the membership cache for bundles that are about to be filed. Called when
 * a drag starts: dragging an *unselected* card carries only that card, whose
 * membership no open inspector has ever asked for, and without it the counts
 * fall back to waiting for the server. The drag itself takes far longer than
 * these requests, so by the time the cursor reaches the sidebar the arithmetic
 * has what it needs.
 */
export function prefetchBundleMemberships(qc: QueryClient, bundleIds: readonly string[]) {
  // One request per bundle; a very large multi-selection is not worth a burst of
  // them, and the invalidation still settles those counts a beat later.
  if (bundleIds.length === 0 || bundleIds.length > MEMBERSHIP_PREFETCH_LIMIT) return
  for (const id of bundleIds) {
    void qc.ensureQueryData({
      queryKey: ['bundle-collections', id],
      queryFn: ({ signal }) => fetchBundleCollections(id, signal),
    })
  }
}

// Apply the bundle fields represented directly by a metadata PATCH
function applyBundlePatch(previous: BundleRead, patch: BundlePatch): BundleRead {
  return {
    ...previous,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
    ...(patch.cover_file_id !== undefined ? { cover_file_id: patch.cover_file_id } : {}),
    ...(patch.notes !== undefined && patch.notes !== null ? { notes: patch.notes } : {}),
  }
}

export function useUpdateBundle(id: string, version?: number) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: BundlePatch) => updateBundle(id, patch, version),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: ['bundle', id] })
      const previous = qc.getQueryData<BundleRead>(['bundle', id])
      qc.setQueryData<BundleRead>(['bundle', id], (current) =>
        current ? applyBundlePatch(current, patch) : current,
      )
      return { previous }
    },
    onError: (_error, _patch, context) => {
      if (context?.previous) qc.setQueryData(['bundle', id], context.previous)
    },
    // The PATCH response is authoritative and avoids a second metadata round trip
    onSuccess: (bundle) => qc.setQueryData(['bundle', id], bundle),
    onSettled: (_bundle, error) => {
      // A conflict/error still refetches the other client's current value
      if (error) void qc.invalidateQueries({ queryKey: ['bundle', id] })
      // Cover artwork and cards can refresh without delaying inspector feedback
      void qc.invalidateQueries({ queryKey: ['browse'] })
    },
  })
}

// Persist the viewer's selected file without treating navigation as metadata editing
export function useBundleCursor(id: string) {
  const qc = useQueryClient()
  return useMutation({
    scope: { id: `bundle-cursor-${id}` },
    mutationFn: (fileId: string) => updateBundleCursor(id, fileId),
    onMutate: (fileId) => {
      qc.setQueryData<BundleRead>(['bundle', id], (previous) =>
        previous ? { ...previous, resume_file_id: fileId } : previous,
      )
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['bundle', id] })
      qc.invalidateQueries({ queryKey: ['browse'] })
      qc.invalidateQueries({ queryKey: ['continue-watching'] })
    },
  })
}

export function useSetBundleTags(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => setBundleTags(id, ids),
    // Optimistic: the chip appears on click rather than after a round trip plus
    // a refetch. Tagging felt like it took a second (owner, 2026-07-27) because
    // the picker only redrew once `bundle-tags` came back, behind a full
    // `browse` refetch competing for the same connections.
    onMutate: async (ids: string[]) => {
      const key = ['bundle-tags', id]
      await Promise.all([
        qc.cancelQueries({ queryKey: key }),
        qc.cancelQueries({ queryKey: ['tag-counts'] }),
        qc.cancelQueries({ queryKey: ['view-counts'] }),
      ])
      // Untagged lists exactly the bundles carrying no tag, and no projection
      // writes it, so a tag change always leaves it for the settle step.
      const unproven = membershipDependentListings(qc, 'tags')
      const previous = qc.getQueryData<{ bundle_id: string; tag_ids: string[] }>(key)
      if (!previous) return { previous, snapshots: [], unproven }
      qc.setQueryData(key, { ...previous, tag_ids: ids })
      // The picker shows a count per tag; it moves with the chip, not after it.
      const snapshots = applyTagCounts(qc, [{ before: previous.tag_ids, after: ids }])
      return { previous, snapshots, unproven }
    },
    onError: (_error, _ids, context) => {
      // Put the old set back; the server rejected the change.
      if (context?.previous) qc.setQueryData(['bundle-tags', id], context.previous)
      restoreSnapshots(qc, context?.snapshots)
    },
    onSettled: (_data, _error, _ids, context) => {
      qc.invalidateQueries({ queryKey: ['bundle-tags', id] })
      qc.invalidateQueries({ queryKey: ['tag-counts'] })
      qc.invalidateQueries({ queryKey: ['view-counts'] })
      // Only the Untagged view's *membership* depends on tags; every other
      // browse row is unaffected, so refetching the whole grid on every tag was
      // work nobody could see. Refetch it lazily instead of forcing it now:
      // an inactive query refetches when its view is next shown.
      qc.invalidateQueries({ queryKey: ['browse'], refetchType: 'none' })
      // Untagged is the exception, and `refetchType: 'none'` would have left it
      // to serve its pre-write rows the moment the view opened.
      reconcileUnprovenListings(qc, context?.unproven)
    },
  })
}

export function useSetBundleCollections(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => setBundleCollections(id, ids),
    // Optimistic for the same reason as tags — see useSetBundleTags.
    onMutate: async (ids: string[]) => {
      const key = ['bundle-collections', id]
      await Promise.all([
        qc.cancelQueries({ queryKey: key }),
        qc.cancelQueries({ queryKey: ['collection-counts'] }),
        qc.cancelQueries({ queryKey: ['collection-stats'] }),
        qc.cancelQueries({ queryKey: ['view-counts'] }),
      ])
      const previous = qc.getQueryData<{ bundle_id: string; collection_ids: string[] }>(key)
      // Unknown membership: nothing can be projected, so every listing this
      // could have moved a bundle in or out of is left for the settle step.
      if (!previous) {
        return {
          previous,
          snapshots: [],
          unproven: projectCollectionListings(qc, [id], null).unproven,
        }
      }
      qc.setQueryData(key, { ...previous, collection_ids: ids })
      // Same arithmetic as a drag — the picker's checkbox files a bundle just as
      // a drop does, and the sidebar should say so at the same moment.
      const change = { before: previous.collection_ids, after: ids }
      // …and so should the grids, or opening the collection just ticked shows
      // last time's contents until the refetch lands.
      const listings = projectCollectionListings(qc, [id], [change])
      const snapshots = [...applyCollectionCounts(qc, [change]), ...listings.snapshots]
      return { previous, snapshots, unproven: listings.unproven }
    },
    onError: (_error, _ids, context) => {
      if (context?.previous) qc.setQueryData(['bundle-collections', id], context.previous)
      restoreSnapshots(qc, context?.snapshots)
    },
    onSettled: (_data, _error, _ids, context) => {
      qc.invalidateQueries({ queryKey: ['bundle-collections', id] })
      invalidateCollectionCounts(qc)
      qc.invalidateQueries({ queryKey: ['view-counts'] })
      reconcileUnprovenListings(qc, context?.unproven)
      // Membership *does* decide which bundles a collection view lists, so this
      // one still refetches — but only the collection-scoped grids, when shown.
      qc.invalidateQueries({ queryKey: ['browse'] })
    },
  })
}

export function useFileMutations(bundleId: string) {
  const qc = useQueryClient()
  const invalidate = ({ files = true, collections = false } = {}) => {
    if (files) qc.invalidateQueries({ queryKey: ['bundle-files', bundleId] })
    qc.invalidateQueries({ queryKey: ['bundle', bundleId] })
    qc.invalidateQueries({ queryKey: ['browse'] })
    if (collections) qc.invalidateQueries({ queryKey: ['collections'] })
  }
  const updateCoverCache = (updated: FileRead) => {
    qc.setQueryData<FileRead[]>(['bundle-files', bundleId], (previous) =>
      previous?.map((file) => (file.id === updated.id ? updated : file)),
    )
    invalidate({ files: false, collections: true })
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
      onSettled: () => invalidate(),
    }),
    // Reordering felt slow for a reason that had nothing to do with the write
    // (a handful of UPDATEs): the list only moved once the round trip finished,
    // and then it *refetched* the file list — a GET that stats every file in the
    // bundle to reconcile missing ones, which on a network volume is the whole
    // delay. The drag now applies to the cache immediately, the server's own
    // response replaces it (no refetch), and only the browse card — whose cover
    // can follow file order — is invalidated, in the background.
    reorder: useMutation({
      mutationFn: (orderedIds: string[]) => reorderFiles(bundleId, orderedIds),
      onMutate: async (orderedIds: string[]) => {
        const key = ['bundle-files', bundleId]
        await qc.cancelQueries({ queryKey: key })
        const previous = qc.getQueryData<FileRead[]>(key)
        if (previous) {
          const byId = new Map(previous.map((file) => [file.id, file]))
          const next = orderedIds.map((id) => byId.get(id)).filter((f) => f !== undefined)
          if (next.length === previous.length) qc.setQueryData<FileRead[]>(key, next)
        }
        return { previous }
      },
      onError: (_error, _ids, context) => {
        if (context?.previous) qc.setQueryData(['bundle-files', bundleId], context.previous)
      },
      onSuccess: (files: FileRead[]) => {
        qc.setQueryData<FileRead[]>(['bundle-files', bundleId], files)
      },
      onSettled: () => {
        qc.invalidateQueries({ queryKey: ['bundle', bundleId] })
        qc.invalidateQueries({ queryKey: ['browse'] })
      },
    }),
    remove: useMutation({
      mutationFn: (fileId: string) => removeFile(bundleId, fileId),
      // Removing a file re-stages it into Unbundled (a fresh provisional bundle),
      // so the Unbundled list, File Browser badges, and the sidebar count must
      // refresh too — not just this bundle's files.
      onSuccess: () => {
        invalidate()
        for (const key of ['unbundled-files', 'file-browser', 'view-counts'])
          qc.invalidateQueries({ queryKey: [key] })
        qc.invalidateQueries({ queryKey: ['continue-watching'] })
      },
    }),
    setCoverFrame: useMutation({
      mutationFn: ({ fileId, time }: { fileId: string; time: number }) =>
        setCoverFrame(fileId, time),
      onSuccess: updateCoverCache,
    }),
    clearCoverFrame: useMutation({
      mutationFn: (fileId: string) => clearCoverFrame(fileId),
      onSuccess: updateCoverCache,
    }),
  }
}

export function useRepairFile(bundleId: string, fileId: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (replacementFileId: string) => repairFile(bundleId, fileId, replacementFileId),
    onSuccess: () => {
      for (const key of [
        'bundle-files',
        'bundle',
        'browse',
        'view-counts',
        'unbundled-files',
        'file-browser',
        'continue-watching',
        'file-repair-candidate',
      ])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

/**
 * Delete one or more bundles (metadata only — files stay on disk). Accepts a
 * list so a multi-selection can be removed in one action; deletes run in
 * parallel and the affected library surfaces are refetched once all settle.
 */
export function useDeleteBundles() {
  const qc = useQueryClient()
  return useMutation({
    // `deleteFiles` sends the bundle's files to the trash as well, through the
    // write-gated route — so it is undoable and they stay listed in the Trash
    // rather than simply vanishing.
    mutationFn: ({ ids, deleteFiles = false }: { ids: string[]; deleteFiles?: boolean }) =>
      Promise.all(ids.map((id) => (deleteFiles ? deleteBundleWithFiles(id) : deleteBundle(id)))),
    onSuccess: () => {
      // Deleting a confirmed bundle re-stages its files into Unbundled, so the
      // Unbundled list + File Browser badges must refresh too.
      for (const key of [
        'browse',
        'view-counts',
        'collection-counts',
        'collection-stats',
        'tag-counts',
        'unbundled-files',
        'file-browser',
        'bundle',
        'bundle-files',
        'continue-watching',
      ])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
}

/**
 * Forget files that are gone from disk (metadata only).
 *
 * The dismissal that is not "delete the bundle": a dead member goes and the
 * grouping around it survives. `fileIds` omitted forgets every missing file in
 * the bundle. Invalidates what deleting a bundle does, because the last one
 * forgotten takes the bundle with it.
 */
export function useForgetMissingFiles() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ bundleId, fileIds }: { bundleId: string; fileIds?: string[] }) =>
      forgetMissingFiles(bundleId, fileIds),
    onSuccess: () => {
      for (const key of [
        'browse',
        'view-counts',
        'collection-counts',
        'collection-stats',
        'tag-counts',
        'unbundled-files',
        'file-browser',
        'bundle',
        'bundle-files',
        'continue-watching',
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
        'collection-stats',
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
      invalidateCollectionCounts(qc)
    },
  })
}

/** How many bundles "Create Collection from Folder…" would file in, so the
 *  dialog can say what the button will do before it is pressed. */
export function useDirectoryBundleCount(directory: string | null) {
  return useQuery({
    queryKey: ['directory-bundle-count', directory ?? ''],
    queryFn: ({ signal }) => fetchDirectoryBundleCount(directory as string, signal),
    enabled: directory !== null && directory !== '',
  })
}

/** Make a collection out of a folder and file its bundles into it. Invalidates
 *  membership-derived surfaces too — the bundles just joined something. */
export function useCreateCollectionFromDirectory() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (payload: { directory: string; name: string; parent_id: string | null }) =>
      createCollectionFromDirectory(payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['collections'] })
      invalidateCollectionCounts(qc)
      qc.invalidateQueries({ queryKey: ['browse'] })
      qc.invalidateQueries({ queryKey: ['bundle'] })
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
      invalidateCollectionCounts(qc)
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
    // Serialized for the same reason as useReorderBundles: the response is the
    // whole resulting order, so responses must apply in commit order.
    scope: { id: 'reorder-collections' },
    mutationFn: ({
      parentId,
      movedIds,
      beforeId,
    }: {
      parentId: string | null
      movedIds: string[]
      beforeId: string | null
    }) => reorderCollections(parentId, movedIds, beforeId),
    // The server answers with the group in its new order, so that is what the
    // cache gets — no invalidate, no refetch. A refetch is a second answer to a
    // question already settled, and any disagreement with it shows up as the
    // row moving a second time on its own.
    // No parameter annotation here on purpose: annotating a callback argument
    // inside useMutation collapses TanStack's generic inference, and `mutate`
    // then accepts *anything* — which is how a call site left on the old
    // `orderedIds` contract survived a clean type check.
    onSuccess: (group) => {
      const byId = new Map(group.map((c) => [c.id, c]))
      const previous = qc.getQueryData<CollectionRead[]>(['collections'])
      qc.setQueryData<CollectionRead[]>(['collections'], (old) =>
        old?.map((c) => byId.get(c.id) ?? c),
      )
      // This drag reparents as well as reorders, and a subtree that changed
      // parents changes what every collection above it — on both sides of the
      // move — counts. Nothing else was telling the sidebar, so the numbers sat
      // on the old tree until something unrelated refetched them. The exact
      // deltas are not computable here (an ancestor counts *distinct* bundles
      // across its whole subtree, and the client holds no membership for the
      // bundles inside the one being moved), so this refetches rather than
      // guesses. A pure reorder within one parent changes nothing and is left
      // alone.
      const reparented = previous?.some((c) => {
        const moved = byId.get(c.id)
        return moved !== undefined && (moved.parent_id ?? null) !== (c.parent_id ?? null)
      })
      if (reparented) invalidateCollectionCounts(qc)
    },
    onError: () => qc.invalidateQueries({ queryKey: ['collections'] }),
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
/** Put the loaded items into the order the server just wrote, keeping each
 *  infinite-query page's length so the virtualizer's offsets stay valid. Ids the
 *  client has not loaded are skipped; anything the server did not name keeps its
 *  place at the tail. */
function applyBrowseOrder(
  data: InfiniteData<BundleBrowsePage>,
  orderedIds: string[],
): InfiniteData<BundleBrowsePage> {
  const all = data.pages.flatMap((p) => p.items as BundleSummary[])
  const byId = new Map(all.map((i) => [i.id, i]))
  const named = orderedIds.flatMap((id) => {
    const item = byId.get(id)
    return item ? [item] : []
  })
  const namedIds = new Set(orderedIds)
  const ordered = [...named, ...all.filter((i) => !namedIds.has(i.id))]
  let idx = 0
  const pages = data.pages.map((p) => {
    const items = ordered.slice(idx, idx + p.items.length)
    idx += p.items.length
    return { ...p, items }
  })
  return { ...data, pages }
}

/**
 * Record that a bundle was opened, then let the listings that rank by it catch
 * up on their own.
 *
 * Opening a bundle changes where it belongs under Date Opened, but nothing was
 * telling those listings so — the Recent view only re-sorted when something else
 * happened to refetch it (navigating back to it, or changing the order), which
 * left the owner's own action invisible until they poked it. Only listings
 * actually sorted by the affected column are invalidated, so this cannot
 * re-shuffle a view the open had no bearing on.
 */
export function useMarkBundleOpened() {
  const qc = useQueryClient()
  return useCallback(
    (id: string) => {
      void markBundleOpened(id).then(() => {
        qc.invalidateQueries({
          queryKey: ['browse'],
          predicate: (query) =>
            (query.queryKey[1] as BrowseQuery | undefined)?.sort === 'date_opened',
        })
        qc.invalidateQueries({ queryKey: ['continue-watching'] })
      })
    },
    [qc],
  )
}

/** Which manual order a browse listing is sorted by, or `undefined` when it is
 *  not on manual sort at all. A collection scopes the order to its own
 *  membership only while showing just its own bundles; flattened contents, the
 *  All view and the system views all read the one global order (mirrors
 *  `_manual_order_column` on the server — keep the two in step). */
function manualScopeOf(query: BrowseQuery | undefined): string | null | undefined {
  if (query?.sort !== 'manual') return undefined
  return query.collectionId != null && query.includeDescendants !== true ? query.collectionId : null
}

/** Apply the same move the server will, to the cached pages, so the card lands
 *  under the cursor immediately. Mirrors `reorder_bundles` — moved items travel
 *  as one block in their existing relative order — but only over what is loaded;
 *  the server settles the rest. */
function moveInBrowsePages(
  data: InfiniteData<BundleBrowsePage>,
  movedIds: string[],
  beforeId: string | null,
): InfiniteData<BundleBrowsePage> {
  const all = data.pages.flatMap((p) => p.items as BundleSummary[])
  const moving = new Set(movedIds)
  const block = all.filter((i) => moving.has(i.id))
  if (block.length === 0 || (beforeId !== null && moving.has(beforeId))) return data
  const rest = all.filter((i) => !moving.has(i.id))
  const at = beforeId === null ? rest.length : rest.findIndex((i) => i.id === beforeId)
  const ordered = at < 0 ? [...rest, ...block] : [...rest.slice(0, at), ...block, ...rest.slice(at)]
  let idx = 0
  const pages = data.pages.map((p) => {
    const items = ordered.slice(idx, idx + p.items.length)
    idx += p.items.length
    return { ...p, items }
  })
  return { ...data, pages }
}

/** Persist a manual drag-reorder of bundles (MANUAL sort).
 *
 * Sends the *move* — which bundles were dragged, and which bundle they were
 * dropped in front of — rather than the order the client believes in. The client
 * only ever holds a page of a collection, so an order built from it was right
 * only by luck; the server resolves the move against the whole scope. The cached
 * pages get the same move applied so the card lands under the cursor at once. */
export function useReorderBundles() {
  const qc = useQueryClient()
  return useMutation({
    // One reorder at a time. Each response carries the whole resulting order,
    // so two in-flight moves whose responses cross on the wire would leave the
    // cache holding whichever landed last — not whichever committed last. A
    // shared scope serializes them; a human can't out-drag a write anyway.
    scope: { id: 'reorder-bundles' },
    mutationFn: ({
      collectionId,
      movedIds,
      beforeId,
    }: {
      collectionId: string | null
      movedIds: string[]
      beforeId: string | null
    }) => reorderBundles(collectionId, movedIds, beforeId),
    onMutate: async ({ collectionId, movedIds, beforeId }) => {
      // Only the listings this move actually reorders. A reorder writes one
      // manual order — a collection's membership order, or the global one — and
      // applying the guess to every cached browse listing meant a drag inside one
      // collection silently rewrote the cached order of the All view and every
      // other collection, which then visibly snapped back the moment one of them
      // was looked at (or refetched): a second, unasked-for reorder of something
      // the user had not touched.
      const affected = {
        queryKey: ['browse'],
        predicate: (query: { queryKey: readonly unknown[] }) =>
          manualScopeOf(query.queryKey[1] as BrowseQuery | undefined) === collectionId,
      }
      await qc.cancelQueries(affected)
      const snapshots = qc.getQueriesData<InfiniteData<BundleBrowsePage>>(affected)
      qc.setQueriesData<InfiniteData<BundleBrowsePage>>(affected, (old) =>
        old ? moveInBrowsePages(old, movedIds, beforeId) : old,
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => {
      for (const [key, data] of ctx?.snapshots ?? []) qc.setQueryData(key, data)
      qc.invalidateQueries({ queryKey: ['browse'] })
    },
    // The server returns the scope's resulting order, so the settled state comes
    // from the same response that decided it. Nothing is invalidated: a refetch
    // is a second answer arriving later, and the row visibly moving again when
    // it disagreed is exactly what a reorder must never do.
    onSuccess: ({ ordered_ids }, { collectionId }) => {
      qc.setQueriesData<InfiniteData<BundleBrowsePage>>(
        {
          queryKey: ['browse'],
          predicate: (query: { queryKey: readonly unknown[] }) =>
            manualScopeOf(query.queryKey[1] as BrowseQuery | undefined) === collectionId,
        },
        (old) => (old ? applyBrowseOrder(old, ordered_ids) : old),
      )
    },
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
    // Dropping bundles on a collection is pure metadata, but the UI used to sit
    // still until the whole browse listing refetched — a round trip plus a page
    // rebuild for an action with a fully predictable outcome. Apply the visible
    // parts up front: pull the moved bundles out of the listings they left, move
    // their memberships, and move the counts those memberships feed. The
    // invalidations below then reconcile with the server's answer, correcting
    // the guess if it was wrong.
    onMutate: async (payload) => {
      const removed = payload.remove_collection_ids ?? []
      // Counts. Not a flat ±1 on the drop target: the server counts a
      // collection's subtree, so filing a bundle into a subcollection of the one
      // being viewed must leave that collection's number alone. `counts.ts`
      // derives the real deltas from the collection tree, which the client
      // already holds — and if any moved bundle's membership is unknown it
      // derives nothing at all, leaving the counts to the invalidation rather
      // than showing a number that is neither the old one nor the new one.
      await Promise.all(
        [
          // `browse` included so an in-flight listing fetch cannot land on top of
          // the projection below and undo it. One started before the drop resolves
          // after it, writes the pre-drop page back, and the settle invalidation
          // is then deduplicated against that very request — leaving the grid
          // showing the state the write already replaced.
          'browse',
          'collection-counts',
          'collection-stats',
          'tag-counts',
          'view-counts',
          'bundle-collections',
          'bundle-tags',
        ].map((key) => qc.cancelQueries({ queryKey: [key] })),
      )
      const snapshots: CacheSnapshot[] = []
      const collections = projectMemberships(
        qc,
        'collections',
        payload.bundle_ids,
        payload.add_collection_ids ?? [],
        removed,
      )
      if (collections) {
        snapshots.push(...collections.snapshots, ...applyCollectionCounts(qc, collections.changes))
      }
      // Called with a null change set when the memberships were unknown, so the
      // listings it could not project are named rather than silently left stale.
      const listings = projectCollectionListings(
        qc,
        payload.bundle_ids,
        collections?.changes ?? null,
      )
      snapshots.push(...listings.snapshots)
      const unproven = [...listings.unproven]
      const tags = projectMemberships(
        qc,
        'tags',
        payload.bundle_ids,
        payload.add_tag_ids ?? [],
        payload.remove_tag_ids ?? [],
      )
      if (tags) snapshots.push(...tags.snapshots, ...applyTagCounts(qc, tags.changes))
      // No projection writes Untagged, so any tag change leaves it unproven.
      if (payload.add_tag_ids?.length || payload.remove_tag_ids?.length) {
        unproven.push(...membershipDependentListings(qc, 'tags'))
      }
      return { snapshots, unproven }
    },
    onError: (_error, _payload, context) => {
      // The browse pruning above is not rolled back here: the invalidation below
      // refetches those listings, and a card flying back into a grid it was
      // never removed from is worse than one that reappears when the list does.
      restoreSnapshots(qc, context?.snapshots)
    },
    onSettled: (_data, _error, _payload, context) => {
      reconcileUnprovenListings(qc, context?.unproven)
      qc.invalidateQueries({ queryKey: ['browse'] })
      qc.invalidateQueries({ queryKey: ['tag-counts'] })
      invalidateCollectionCounts(qc)
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
