import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { BundleBrowsePage, BundleSummary, CollectionRead } from './client'
import { useBatchUpdate, useSetBundleCollections, type BrowseQuery } from './hooks'

const api = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
  setBundleCollections: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  batchUpdate: api.batchUpdate,
  setBundleCollections: api.setBundleCollections,
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

function summary(id: string): BundleSummary {
  return {
    id,
    title: id,
    rating: null,
    file_count: 1,
    total_size: 0,
    has_missing: false,
    has_cover: false,
    openable: true,
    cover_key: null,
    media_kind: 'video',
    date_added: '2026-01-01T00:00:00Z',
    grouping_state: 'confirmed',
  } as unknown as BundleSummary
}

/** One cached browse listing, as `useBrowse` stores it. */
function listing(
  client: QueryClient,
  scope: Partial<BrowseQuery> & { collectionId: string },
  ids: string[],
) {
  const key: BrowseQuery = {
    view: 'all',
    sort: 'manual',
    order: 'asc',
    limit: 100,
    ...scope,
  } as BrowseQuery
  client.setQueryData<InfiniteData<BundleBrowsePage>>(['browse', key], {
    pages: [
      {
        items: ids.map(summary),
        total: ids.length,
        offset: 0,
        limit: 100,
      } as unknown as BundleBrowsePage,
    ],
    pageParams: [0],
  })
  return key
}

const itemsIn = (client: QueryClient, key: BrowseQuery) =>
  client
    .getQueryData<InfiniteData<BundleBrowsePage>>(['browse', key])!
    .pages.flatMap((page) => page.items.map((item) => item.id))

const totalIn = (client: QueryClient, key: BrowseQuery) =>
  client.getQueryData<InfiniteData<BundleBrowsePage>>(['browse', key])!.pages[0]!.total

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
  return client
}

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  api.batchUpdate.mockReset()
  api.setBundleCollections.mockReset()
})

test('a bundle filed into a collection appears in that collection’s cached listing', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  const source = listing(client, { collectionId: 'crate' }, ['b1', 'b2'])
  const destination = listing(client, { collectionId: 'shelf' }, ['b9'])
  const inFlight: { destination: string[]; total: number } = { destination: [], total: -1 }
  api.batchUpdate.mockImplementation(async () => {
    inFlight.destination = itemsIn(client, destination)
    inFlight.total = totalIn(client, destination)
    return { updated: 1 }
  })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )

  // Before the server answered. Opening the destination used to render its
  // cached listing — without the bundle — while the refetch was in flight.
  expect(inFlight.destination).toEqual(['b1', 'b9'])
  expect(inFlight.total).toBe(2)
  expect(itemsIn(client, source)).toEqual(['b2'])
  expect(totalIn(client, source)).toBe(1)
})

test('a listing showing subcollection contents gains a bundle filed into a child', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  const flat = listing(client, { collectionId: 'shelf' }, [])
  const deep = listing(client, { collectionId: 'shelf', includeDescendants: true }, [])
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  // Give the projection a summary row to draw from, as the grid it came from would.
  listing(client, { collectionId: 'crate' }, ['b1'])
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf-nested'] }),
  )

  // The parent shows it only when it is showing its descendants' contents —
  // the same subtree rule the sidebar counts follow.
  expect(itemsIn(client, deep)).toEqual(['b1'])
  expect(itemsIn(client, flat)).toEqual([])
})

test('a filtered listing is left to the refetch rather than guessed at', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  listing(client, { collectionId: 'crate' }, ['b1'])
  const filtered = listing(
    client,
    { collectionId: 'shelf', filter: { field: 'rating', op: 'gte', value: 4 } } as never,
    [],
  )
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf'] }))

  // Whether an unrated bundle belongs in a rating filter is the server's call.
  expect(itemsIn(client, filtered)).toEqual([])
})

test('the collection picker projects the same way a drop does', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  listing(client, { collectionId: 'crate' }, ['b1'])
  const destination = listing(client, { collectionId: 'shelf' }, [])
  api.setBundleCollections.mockResolvedValue({})
  const { result } = renderHook(() => useSetBundleCollections('b1'), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync(['shelf']))

  expect(itemsIn(client, destination)).toEqual(['b1'])
})

test('a rejected write puts the listings back', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  const source = listing(client, { collectionId: 'crate' }, ['b1', 'b2'])
  const destination = listing(client, { collectionId: 'shelf' }, [])
  const inFlight: string[] = []
  api.batchUpdate.mockImplementation(async () => {
    inFlight.push(...itemsIn(client, destination))
    throw new Error('nope')
  })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(async () => {
    await result.current
      .mutateAsync({
        bundle_ids: ['b1'],
        add_collection_ids: ['shelf'],
        remove_collection_ids: ['crate'],
      })
      .catch(() => undefined)
  })

  // It really did move first — otherwise this would pass with no projection at all.
  expect(inFlight).toEqual(['b1'])
  expect(itemsIn(client, source)).toEqual(['b1', 'b2'])
  expect(totalIn(client, source)).toBe(2)
  expect(itemsIn(client, destination)).toEqual([])
})
