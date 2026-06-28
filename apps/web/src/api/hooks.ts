import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type BatchUpdate,
  type BrowseParams,
  type BundlePatch,
  type FilePatch,
  type FilterExpression,
  type LibraryCreate,
  type LibraryRegister,
  type SmartCollectionCreate,
  type SmartCollectionUpdate,
  batchUpdate,
  browseBundles,
  createLibrary,
  createSmartCollection,
  deleteSmartCollection,
  enqueueScan,
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
  updateBundle,
  updateFile,
  updateSmartCollection,
} from './client'

export type BrowseQuery = Omit<BrowseParams, 'offset'>

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
      mutationFn: ({ id, payload }: { id: string; payload: SmartCollectionUpdate }) =>
        updateSmartCollection(id, payload),
      onSuccess: invalidate,
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

/** Enqueue a scan of the active library. The worker runs it asynchronously; we
 * optimistically invalidate browse-facing queries so a later refresh reflects
 * discovered media. */
export function useScan() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => enqueueScan(),
    onSuccess: () => {
      for (const key of ['browse', 'view-counts', 'collection-counts', 'tag-counts', 'file-view'])
        qc.invalidateQueries({ queryKey: [key] })
    },
  })
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

export function useUpdateBundle(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (patch: BundlePatch) => updateBundle(id, patch),
    onSuccess: () => {
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
      mutationFn: ({ fileId, patch }: { fileId: string; patch: FilePatch }) =>
        updateFile(bundleId, fileId, patch),
      onSuccess: invalidate,
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
