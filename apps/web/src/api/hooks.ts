import { useInfiniteQuery, useQuery } from '@tanstack/react-query'

import {
  type BrowseParams,
  browseBundles,
  fetchAllFolders,
  fetchBundle,
  fetchBundleFiles,
  fetchFolderCounts,
  fetchViewCounts,
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
