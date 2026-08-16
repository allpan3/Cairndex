/**
 * Whether the sidebar counts end up right when drops overlap the refetches they
 * trigger. Owner-reported: the count "still acts up sometimes, it doesn't always
 * correct". The optimistic arithmetic is covered in `hooks.counts.test.tsx`; this
 * file is about the races around it — a second drag landing on the first one's
 * in-flight refetch, and a refetch that answers with pre-drop numbers.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { CollectionCounts, CollectionRead } from './client'
import { useBatchUpdate, useCollectionCounts } from './hooks'

const api = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
  fetchCollectionCounts: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  batchUpdate: api.batchUpdate,
  fetchCollectionCounts: api.fetchCollectionCounts,
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

/** These collections have no children, so both figures are the same number. */
const both = (map: Record<string, number>): CollectionCounts => ({ subtree: map, direct: map })

function seedClient(): QueryClient {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { throwOnError: false } },
  })
  client.setQueryData(['collections'], [collection('shelf'), collection('crate')])
  return client
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const counts = (client: QueryClient) =>
  client.getQueryData<CollectionCounts>(['collection-counts'])?.subtree

beforeEach(() => {
  api.batchUpdate.mockReset()
  api.fetchCollectionCounts.mockReset()
})

/** The sidebar's own query, so `collection-counts` is *active* — an inactive one
 *  is never refetched by an invalidation, and the whole question is whether the
 *  server's answer lands. */
function mountSidebarAndDrop(client: QueryClient) {
  return renderHook(() => ({ counts: useCollectionCounts(), batch: useBatchUpdate() }), {
    wrapper: wrapper(client),
  })
}

test('the server answer lands after a drop, replacing the optimistic guess', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  api.fetchCollectionCounts.mockResolvedValueOnce(both({ shelf: 5, crate: 3 }))
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = mountSidebarAndDrop(client)
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)).toBeDefined())
  })

  // The server disagrees with the optimistic +1/-1 on purpose — it is the one
  // that has to win.
  api.fetchCollectionCounts.mockResolvedValue(both({ shelf: 42, crate: 7 }))
  await act(() =>
    result.current.batch.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)?.shelf).toBe(42))
  })

  expect(counts(client)).toEqual({ shelf: 42, crate: 7 })
})

test('a second drop landing on the first one’s refetch still ends on the server answer', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  client.setQueryData(['bundle-collections', 'b2'], { bundle_id: 'b2', collection_ids: ['crate'] })
  api.fetchCollectionCounts.mockResolvedValueOnce(both({ shelf: 5, crate: 3 }))
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = mountSidebarAndDrop(client)
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)).toBeDefined())
  })

  // The first drop's reconciling refetch is still in flight when the second drop
  // starts, and the second drop cancels it. Only the last answer is the truth.
  let releaseFirst: () => void = () => undefined
  const firstRefetch = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  api.fetchCollectionCounts.mockImplementationOnce(async () => {
    await firstRefetch
    return both({ shelf: 6, crate: 2 })
  })
  api.fetchCollectionCounts.mockResolvedValue(both({ shelf: 7, crate: 1 }))

  await act(() =>
    result.current.batch.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )
  await act(() =>
    result.current.batch.mutateAsync({
      bundle_ids: ['b2'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )
  await act(async () => {
    releaseFirst()
    await firstRefetch
  })
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)?.shelf).toBe(7))
  })

  expect(counts(client)).toEqual({ shelf: 7, crate: 1 })
})

test('a refetch already in flight when the drop lands cannot strand its stale numbers', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  api.fetchCollectionCounts.mockResolvedValueOnce(both({ shelf: 5, crate: 3 }))
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = mountSidebarAndDrop(client)
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)).toBeDefined())
  })

  // A refetch that started before the drop and answers after it, with pre-drop
  // numbers. This is the shape that defeated every earlier fix on the listings.
  let releaseStale: () => void = () => undefined
  const stale = new Promise<void>((resolve) => {
    releaseStale = resolve
  })
  api.fetchCollectionCounts.mockImplementationOnce(async () => {
    await stale
    return both({ shelf: 5, crate: 3 })
  })
  api.fetchCollectionCounts.mockResolvedValue(both({ shelf: 6, crate: 2 }))
  void client.refetchQueries({ queryKey: ['collection-counts'] })

  await act(() =>
    result.current.batch.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )
  await act(async () => {
    releaseStale()
    await stale
  })
  await act(async () => {
    await vi.waitFor(() => expect(counts(client)?.shelf).toBe(6))
  })

  expect(counts(client)).toEqual({ shelf: 6, crate: 2 })
})
