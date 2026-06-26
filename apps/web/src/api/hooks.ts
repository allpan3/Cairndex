import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import {
  type BatchUpdate,
  type BrowseParams,
  type BundlePatch,
  type FilePatch,
  batchUpdate,
  browseBundles,
  fetchAllFolders,
  fetchBundle,
  fetchBundleFiles,
  fetchBundleFolders,
  fetchBundleTags,
  fetchFolderCounts,
  fetchTagCounts,
  fetchTagGroupTags,
  fetchTagGroups,
  fetchTags,
  fetchViewCounts,
  removeFile,
  reorderFiles,
  setBundleFolders,
  setBundleTags,
  updateBundle,
  updateFile,
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
  return useQuery({ queryKey: ['view-counts'], queryFn: ({ signal }) => fetchViewCounts(signal) })
}

export function useFolders() {
  return useQuery({ queryKey: ['folders'], queryFn: ({ signal }) => fetchAllFolders(signal) })
}

export function useFolderCounts() {
  return useQuery({
    queryKey: ['folder-counts'],
    queryFn: ({ signal }) => fetchFolderCounts(signal),
  })
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: ({ signal }) => fetchTags(signal) })
}

export function useTagGroups() {
  return useQuery({ queryKey: ['tag-groups'], queryFn: ({ signal }) => fetchTagGroups(signal) })
}

export function useTagCounts() {
  return useQuery({ queryKey: ['tag-counts'], queryFn: ({ signal }) => fetchTagCounts(signal) })
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

export function useBundleFolders(id: string | null) {
  return useQuery({
    queryKey: ['bundle-folders', id],
    queryFn: ({ signal }) => fetchBundleFolders(id as string, signal),
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

export function useSetBundleFolders(id: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => setBundleFolders(id, ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bundle-folders', id] })
      qc.invalidateQueries({ queryKey: ['folder-counts'] })
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
      qc.invalidateQueries({ queryKey: ['folder-counts'] })
      qc.invalidateQueries({ queryKey: ['view-counts'] })
    },
  })
}
