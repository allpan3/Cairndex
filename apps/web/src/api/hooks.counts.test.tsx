import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { CollectionRead, ViewCounts } from './client'
import {
  useBatchUpdate,
  useReorderCollections,
  useSetBundleCollections,
  useSetBundleTags,
} from './hooks'

const api = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
  setBundleCollections: vi.fn(),
  setBundleTags: vi.fn(),
  reorderCollections: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  batchUpdate: api.batchUpdate,
  setBundleCollections: api.setBundleCollections,
  setBundleTags: api.setBundleTags,
  reorderCollections: api.reorderCollections,
}))

function collection(id: string, parentId: string | null = null): CollectionRead {
  return {
    id,
    parent_id: parentId,
    name: id,
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  }
}

const VIEW_COUNTS: ViewCounts = {
  all: 10,
  recent: 10,
  uncategorized: 4,
  untagged: 6,
  missing: 0,
  unbundled: 0,
}

//   shelf ── shelf-nested
//   crate
function seedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { throwOnError: false } },
  })
  client.setQueryData(
    ['collections'],
    [collection('shelf'), collection('shelf-nested', 'shelf'), collection('crate')],
  )
  client.setQueryData(['collection-counts'], { shelf: 5, 'shelf-nested': 2, crate: 3 })
  client.setQueryData(['view-counts'], VIEW_COUNTS)
  client.setQueryData(['tag-counts'], { blue: 4, green: 1 })
  return client
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const counts = (client: QueryClient) =>
  client.getQueryData<Record<string, number>>(['collection-counts'])
const views = (client: QueryClient) => client.getQueryData<ViewCounts>(['view-counts'])

beforeEach(() => {
  api.batchUpdate.mockReset()
  api.setBundleCollections.mockReset()
  api.setBundleTags.mockReset()
  api.reorderCollections.mockReset()
})

test('a drag between collections moves the counts while the write is still in flight', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  const inFlight: Record<string, number>[] = []
  api.batchUpdate.mockImplementation(async () => {
    inFlight.push({ ...counts(client)! })
    return { updated: 1 }
  })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf-nested'],
      remove_collection_ids: ['crate'],
    }),
  )

  // Before the server answered: the subcollection and its parent gained the
  // bundle, the source lost it.
  expect(inFlight[0]).toEqual({ shelf: 6, 'shelf-nested': 3, crate: 2 })
  expect(client.getQueryData(['bundle-collections', 'b1'])).toEqual({
    bundle_id: 'b1',
    collection_ids: ['shelf-nested'],
  })
})

test('filing into a subcollection of the collection already holding it leaves the parent alone', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['shelf'] })
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf-nested'],
      remove_collection_ids: ['shelf'],
    }),
  )

  expect(counts(client)).toEqual({ shelf: 5, 'shelf-nested': 3, crate: 3 })
})

test('a bundle gaining its first collection leaves Uncategorized', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['crate'] }))

  expect(views(client)?.uncategorized).toBe(VIEW_COUNTS.uncategorized - 1)
})

test('a multi-select batch sums, and an unknown membership leaves the counts to the server', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  client.setQueryData(['bundle-collections', 'b2'], { bundle_id: 'b2', collection_ids: [] })
  api.batchUpdate.mockResolvedValue({ updated: 2 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({ bundle_ids: ['b1', 'b2'], add_collection_ids: ['crate'] }),
  )
  expect(counts(client)?.crate).toBe(5)

  // b3's memberships were never loaded: guessing would put a number on screen
  // that is neither the old count nor the new one, so nothing moves until the
  // refetch lands.
  const before = { ...counts(client)! }
  await act(() =>
    result.current.mutateAsync({ bundle_ids: ['b1', 'b3'], add_collection_ids: ['shelf'] }),
  )
  expect(counts(client)).toEqual(before)
})

test('a rejected batch puts every count back', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  client.setQueryData(['bundle-tags', 'b1'], { bundle_id: 'b1', tag_ids: [] })
  api.batchUpdate.mockRejectedValue(new Error('conflict'))
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(async () => {
    await result.current
      .mutateAsync({
        bundle_ids: ['b1'],
        add_collection_ids: ['shelf'],
        remove_collection_ids: ['crate'],
        add_tag_ids: ['green'],
      })
      .catch(() => undefined)
  })

  expect(counts(client)).toEqual({ shelf: 5, 'shelf-nested': 2, crate: 3 })
  expect(client.getQueryData(['tag-counts'])).toEqual({ blue: 4, green: 1 })
  expect(views(client)).toEqual(VIEW_COUNTS)
  expect(client.getQueryData(['bundle-collections', 'b1'])).toEqual({
    bundle_id: 'b1',
    collection_ids: ['crate'],
  })
})

test('the collection picker moves the same counts as a drag', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  const inFlight: Record<string, number>[] = []
  api.setBundleCollections.mockImplementation(async () => {
    inFlight.push({ ...counts(client)! })
  })
  const { result } = renderHook(() => useSetBundleCollections('b1'), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync(['shelf-nested']))

  expect(inFlight[0]).toEqual({ shelf: 6, 'shelf-nested': 3, crate: 3 })
  expect(views(client)?.uncategorized).toBe(VIEW_COUNTS.uncategorized - 1)
})

test('tagging moves the tag count and Untagged with the chip', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-tags', 'b1'], { bundle_id: 'b1', tag_ids: [] })
  const inFlight: Record<string, number>[] = []
  api.setBundleTags.mockImplementation(async () => {
    inFlight.push({ ...client.getQueryData<Record<string, number>>(['tag-counts'])! })
  })
  const { result } = renderHook(() => useSetBundleTags('b1'), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync(['green']))

  expect(inFlight[0]).toEqual({ blue: 4, green: 2 })
  expect(views(client)?.untagged).toBe(VIEW_COUNTS.untagged - 1)
})

test('the open collection inspector moves with the sidebar, subtree and direct apart', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  // Inspecting the parent while a bundle is filed into its child: the parent's
  // subtree total gains it, its own "directly in this collection" does not.
  client.setQueryData(['collection-stats', 'shelf'], {
    direct_bundles: 3,
    total_bundles: 5,
    subcollections: 1,
  })
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf-nested'] }),
  )

  expect(client.getQueryData(['collection-stats', 'shelf'])).toEqual({
    direct_bundles: 3,
    total_bundles: 6,
    subcollections: 1,
  })
})

test('dragging a collection into another refetches the counts its subtree changed', async () => {
  const client = seedClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  api.reorderCollections.mockResolvedValue([collection('shelf'), collection('crate', 'shelf')])
  const { result } = renderHook(() => useReorderCollections(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({ parentId: 'shelf', movedIds: ['crate'], beforeId: null }),
  )

  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['collection-counts'] })
  // The inspector's own figures are the same fact, so they refresh together.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['collection-stats'] })
})

test('reordering within one parent changes no count, so it refetches none', async () => {
  const client = seedClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  api.reorderCollections.mockResolvedValue([collection('crate'), collection('shelf')])
  const { result } = renderHook(() => useReorderCollections(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({ parentId: null, movedIds: ['crate'], beforeId: 'shelf' }),
  )

  expect(invalidate).not.toHaveBeenCalled()
})
