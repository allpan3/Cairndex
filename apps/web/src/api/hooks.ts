import {
  type InfiniteData,
  type QueryClient,
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
  type CollectionCreate,
  type CollectionRead,
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
  type GroupingStemModes,
  type JobRead,
  type LibraryCreate,
  type LibraryRead,
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
  setGroupingProposalDestination,
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
async function watchOptionalJob(
  job: Promise<JobRead>,
  onProgress?: JobProgressFn,
  onSuccess?: () => void,
): Promise<void> {
  try {
    await waitForJob(await job, onProgress)
    onSuccess?.()
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
      onSuccess: refresh,
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
      }: {
        file: File
        destDir: string
        onConflict?: ConflictPolicy
        // No `link`: an imported file is copied into the folder, not fast-added
        // into a one-file bundle. It shows in the File Browser; bundling stays a
        // separate, deliberate action.
      }) => importFile(file, { destDir, onConflict }),
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
    'bundle-files',
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

// Read the post-reconciliation linked-missing total from a completed scan
function scanMissingTotal(job: JobRead): number {
  const result = job.result as Record<string, unknown> | null
  const count = Number(result?.missing_total ?? 0)
  return Number.isSafeInteger(count) && count >= 0 ? count : 0
}

interface MaintenanceOptions {
  onGroupingPlan?: (planId: string) => void
  onScanComplete?: (missingTotal: number) => void
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
      options.onScanComplete?.(scanMissingTotal(scanJob))
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
      options.onScanComplete?.(scanMissingTotal(scanJob))
      await waitForJob(await enqueueProbe(), options.onProgress)
      return scanJob
    },
    onSuccess: (job) => {
      invalidateLibraryContent(qc)
      notifyGroupingPlan(job, options.onGroupingPlan)
      void watchOptionalJob(enqueueStoryboards(), options.onProgress, () =>
        qc.invalidateQueries({ queryKey: ['playback'] }),
      )
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
    mutationFn: (stemModes?: GroupingStemModes) => generateGroupingPlan(stemModes),
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

/** Reparent one reviewed bundle and update the open plan in-place. */
export function useReparentGroupingProposal(planId: string | null) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({
      proposalId,
      parentProposalId,
    }: {
      proposalId: string
      parentProposalId: string | null
    }) => {
      if (!planId) throw new Error('no grouping plan selected')
      return reparentGroupingProposal(planId, proposalId, parentProposalId)
    },
    onSuccess: (updated) => updateGroupingProposals(qc, planId, [updated]),
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
export function useFileBrowser(path: string | null, enabled = true) {
  return useQuery({
    queryKey: ['file-browser', path ?? ''],
    queryFn: ({ signal }) => fetchFileBrowserEntries(path, signal),
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
    mutationFn: (ids: string[]) => Promise.all(ids.map((id) => deleteBundle(id))),
    onSuccess: () => {
      // Deleting a confirmed bundle re-stages its files into Unbundled, so the
      // Unbundled list + File Browser badges must refresh too.
      for (const key of [
        'browse',
        'view-counts',
        'collection-counts',
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
    onSuccess: (group: CollectionRead[]) => {
      const byId = new Map(group.map((c) => [c.id, c]))
      qc.setQueryData<CollectionRead[]>(['collections'], (old) =>
        old?.map((c) => byId.get(c.id) ?? c),
      )
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
    // parts up front: pull the moved bundles out of the listings they left, and
    // bump the collection counts. The invalidations below then reconcile with
    // the server's answer, correcting the guess if it was wrong.
    onMutate: (payload) => {
      const removed = payload.remove_collection_ids ?? []
      if (removed.length > 0 && payload.bundle_ids.length > 0) {
        const gone = new Set(payload.bundle_ids)
        qc.setQueriesData<InfiniteData<BundleBrowsePage>>(
          {
            queryKey: ['browse'],
            predicate: (query) => {
              const scope = query.queryKey[1] as BrowseQuery | undefined
              return scope?.collectionId != null && removed.includes(scope.collectionId)
            },
          },
          (data) =>
            data && {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.filter((item) => !gone.has(item.id)),
                total: page.total - payload.bundle_ids.length,
              })),
            },
        )
      }
      // Deliberately no optimistic *count* math. The server counts a collection's
      // subtree (moving a bundle between a parent and its own child leaves the
      // parent's number unchanged), so a flat ±1 here disagrees with the truth
      // for exactly the common gesture — filing a bundle into a subcollection —
      // and a wrong number on screen is worse than one arriving a beat later.
      // The invalidation below brings the real counts with the next round trip.
    },
    onSettled: () => {
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
