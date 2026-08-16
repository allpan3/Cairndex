import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { BundleBrowsePage, BundleSummary, CollectionRead } from './client'
import { useBatchUpdate, useBrowse, useSetBundleCollections, type BrowseQuery } from './hooks'

const api = vi.hoisted(() => ({
  batchUpdate: vi.fn(),
  setBundleCollections: vi.fn(),
  browseBundles: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  batchUpdate: api.batchUpdate,
  setBundleCollections: api.setBundleCollections,
  browseBundles: api.browseBundles,
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

function page(ids: string[]): BundleBrowsePage {
  return {
    items: ids.map(summary),
    total: ids.length,
    offset: 0,
    limit: 100,
  } as unknown as BundleBrowsePage
}

/** One cached browse listing, as `useBrowse` stores it. */
function listing(client: QueryClient, scope: Partial<BrowseQuery>, ids: string[]) {
  const key: BrowseQuery = {
    view: 'all',
    sort: 'manual',
    order: 'asc',
    limit: 100,
    ...scope,
  } as BrowseQuery
  client.setQueryData<InfiniteData<BundleBrowsePage>>(['browse', key], {
    pages: [page(ids)],
    pageParams: [0],
  })
  return key
}

const cached = (client: QueryClient, key: BrowseQuery) =>
  client.getQueryData<InfiniteData<BundleBrowsePage>>(['browse', key])

const itemsIn = (client: QueryClient, key: BrowseQuery) =>
  cached(client, key)!.pages.flatMap((page) => page.items.map((item) => item.id))

const totalIn = (client: QueryClient, key: BrowseQuery) => cached(client, key)!.pages[0]!.total

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
  api.browseBundles.mockReset()
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

test('a filtered listing is dropped rather than left to answer from stale rows', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  listing(client, { collectionId: 'crate' }, ['b1'])
  const filtered = listing(
    client,
    { collectionId: 'shelf', filter: { field: 'rating', op: 'gte', value: 4 } } as never,
    [],
  )
  const inFlight: string[][] = []
  api.batchUpdate.mockImplementation(async () => {
    inFlight.push(itemsIn(client, filtered))
    return { updated: 1 }
  })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf'] }))

  // Whether an unrated bundle belongs in a rating filter is the server's call,
  // so it is never guessed into the listing…
  expect(inFlight[0]).toEqual([])
  // …and the listing is then removed rather than merely invalidated. Marking it
  // stale would leave React Query free to serve these pre-drop rows the instant
  // the view opened, refetching behind them — the count moves, the grid doesn't.
  expect(cached(client, filtered)).toBeUndefined()
})

test('a destination with no cached row to draw is dropped rather than left short', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  // No listing anywhere holds b1, so the projection has no summary to draw with.
  const destination = listing(client, { collectionId: 'shelf' }, ['b9'])
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf'] }))

  expect(cached(client, destination)).toBeUndefined()
})

test('Uncategorized is dropped when a bundle gains its first collection', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  const uncategorized = listing(client, { view: 'uncategorized' }, ['b1'])
  // Membership decides what Uncategorized holds, but not what All holds.
  const all = listing(client, { view: 'all' }, ['b1'])
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() => result.current.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf'] }))

  expect(cached(client, uncategorized)).toBeUndefined()
  expect(itemsIn(client, all)).toEqual(['b1'])
})

test('an unknown membership drops every listing the write could have moved', async () => {
  const client = seedClient()
  // b1's memberships were never loaded, so no delta is computable and nothing is
  // projected — the case a fast drag hits when the prefetch has not landed.
  const source = listing(client, { collectionId: 'crate' }, ['b1'])
  const uncategorized = listing(client, { view: 'uncategorized' }, [])
  const all = listing(client, { view: 'all' }, ['b1'])
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )

  expect(cached(client, source)).toBeUndefined()
  expect(cached(client, uncategorized)).toBeUndefined()
  expect(itemsIn(client, all)).toEqual(['b1'])
})

test('a listing fetch already in flight cannot land on top of the drop', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: ['crate'] })
  const source = listing(client, { collectionId: 'crate' }, ['b1', 'b2'])
  // A refetch that started before the drop and answers after it, carrying the
  // pre-drop page. Left running it overwrites the projection, and the settle
  // invalidation is deduplicated against this very request.
  let answer: () => void = () => undefined
  const pending = new Promise<void>((resolve) => {
    answer = resolve
  })
  void client
    .fetchInfiniteQuery({
      queryKey: ['browse', source],
      queryFn: async () => {
        await pending
        return page(['b1', 'b2'])
      },
      initialPageParam: 0,
    })
    .catch(() => undefined)
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => useBatchUpdate(), { wrapper: wrapper(client) })

  await act(() =>
    result.current.mutateAsync({
      bundle_ids: ['b1'],
      add_collection_ids: ['shelf'],
      remove_collection_ids: ['crate'],
    }),
  )
  await act(async () => {
    answer()
    await pending
  })

  expect(itemsIn(client, source)).toEqual(['b2'])
})

test('the listing on screen is refetched in place rather than dropped', async () => {
  const client = seedClient()
  client.setQueryData(['bundle-collections', 'b1'], { bundle_id: 'b1', collection_ids: [] })
  // Filtered, so the projection cannot prove it — but it is the grid the owner is
  // looking at, and removing it would blank the view under the cursor.
  const watched: BrowseQuery = {
    view: 'all',
    sort: 'manual',
    order: 'asc',
    limit: 100,
    collectionId: 'shelf',
    filter: { field: 'rating', op: 'gte', value: 4 },
  } as never
  api.browseBundles.mockResolvedValue(page(['b9']))
  api.batchUpdate.mockResolvedValue({ updated: 1 })
  const { result } = renderHook(() => ({ browse: useBrowse(watched), batch: useBatchUpdate() }), {
    wrapper: wrapper(client),
  })
  await act(async () => {
    await vi.waitFor(() => expect(cached(client, watched)).toBeDefined())
  })

  await act(() =>
    result.current.batch.mutateAsync({ bundle_ids: ['b1'], add_collection_ids: ['shelf'] }),
  )

  expect(cached(client, watched)).toBeDefined()
  expect(itemsIn(client, watched)).toEqual(['b9'])
  // Kept means refetched: it was invalidated, so the server answered again.
  expect(api.browseBundles.mock.calls.length).toBeGreaterThan(1)
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
