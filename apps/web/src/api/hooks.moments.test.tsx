import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { useMomentMutations } from './hooks'

const api = vi.hoisted(() => ({
  setMomentTags: vi.fn(),
  createMoment: vi.fn(),
  deleteMoment: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  setMomentTags: api.setMomentTags,
  createMoment: api.createMoment,
  deleteMoment: api.deleteMoment,
}))

function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset()
})

// The bundle's chips update from the same answer that changed them, rather than
// from a later refetch that can disagree with it (ADR-0025).
test('a moment tag assignment writes the bundle tags it caused', async () => {
  const client = freshClient()
  client.setQueryData(['bundle-tags', 'bundle'], { bundle_id: 'bundle', tag_ids: ['by-hand'] })
  api.setMomentTags.mockResolvedValue({
    moment_id: 'moment',
    tag_ids: ['from-moment'],
    bundle_tag_ids: ['by-hand', 'from-moment'],
  })

  const { result } = renderHook(() => useMomentMutations('bundle'), {
    wrapper: wrapper(client),
  })
  act(() => result.current.setTags.mutate({ momentId: 'moment', ids: ['from-moment'] }))

  await waitFor(() =>
    expect(client.getQueryData(['bundle-tags', 'bundle'])).toEqual({
      bundle_id: 'bundle',
      tag_ids: ['by-hand', 'from-moment'],
    }),
  )
})

// Deleting a moment leaves its tags on the bundle (ADR-0025), so there is
// nothing about the bundle's tags or the per-tag counts that can have changed —
// and invalidating them anyway would refetch the whole taxonomy for nothing.
test('deleting a moment does not disturb the bundle tag caches', async () => {
  const client = freshClient()
  api.deleteMoment.mockResolvedValue(undefined)
  const invalidated: unknown[] = []
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters) => {
    invalidated.push(filters?.queryKey)
    return Promise.resolve()
  })

  const { result } = renderHook(() => useMomentMutations('bundle'), {
    wrapper: wrapper(client),
  })
  act(() => result.current.remove.mutate('moment'))

  await waitFor(() => expect(invalidated.length).toBeGreaterThan(0))
  expect(invalidated).toEqual([['moments', 'bundle']])
})

// Creating one *can* carry tags, so it does move the bundle's set.
test('creating a moment refreshes the tag caches it may have moved', async () => {
  const client = freshClient()
  api.createMoment.mockResolvedValue({ id: 'moment', tag_ids: ['t'] })
  const invalidated: unknown[] = []
  vi.spyOn(client, 'invalidateQueries').mockImplementation((filters) => {
    invalidated.push(filters?.queryKey)
    return Promise.resolve()
  })

  const { result } = renderHook(() => useMomentMutations('bundle'), {
    wrapper: wrapper(client),
  })
  act(() =>
    result.current.create.mutate({ file_id: 'file', start_s: 1, end_s: null, tag_ids: ['t'] }),
  )

  await waitFor(() => expect(invalidated).toContainEqual(['bundle-tags', 'bundle']))
  expect(invalidated).toContainEqual(['tag-counts'])
})

// A surface with no bundle to hold a moment must not build a URL with an empty
// id in it. Every caller is gated on the same fact; this is the backstop.
test('a mutation without a bundle refuses rather than requesting', async () => {
  const client = freshClient()
  const { result } = renderHook(() => useMomentMutations(null), { wrapper: wrapper(client) })

  act(() => result.current.create.mutate({ file_id: 'file', start_s: 1 }))

  await waitFor(() => expect(result.current.create.isError).toBe(true))
  expect(api.createMoment).not.toHaveBeenCalled()
})

const moment = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'm',
  bundle_id: 'bundle',
  file_id: 'f',
  start_s: 10,
  end_s: null,
  comment: null,
  tag_ids: [],
  created_at: '',
  updated_at: '',
  version: 1,
  ...over,
})

// Marking a moment returned the row and then threw the list away to fetch it
// again, so the row appeared a second round trip after the press (owner,
// 2026-08-30). The answer is the row; it goes in.
test('a created moment lands in the list from the answer, without a refetch', async () => {
  const client = freshClient()
  client.setQueryData(['moments', 'bundle'], [moment({ id: 'early', start_s: 5 })])
  api.createMoment.mockResolvedValue(moment({ id: 'fresh', start_s: 20 }))
  const invalidate = vi.spyOn(client, 'invalidateQueries')

  const { result } = renderHook(() => useMomentMutations('bundle'), { wrapper: wrapper(client) })
  act(() => result.current.create.mutate({ file_id: 'f', start_s: 20, end_s: null }))

  await waitFor(() =>
    expect(
      (client.getQueryData(['moments', 'bundle']) as { id: string }[]).map((m) => m.id),
    ).toEqual(['early', 'fresh']),
  )
  // An untagged capture cannot have moved a tag count or the bundle's chips, so
  // none of those are asked to refetch either.
  expect(invalidate).not.toHaveBeenCalled()
})

// `list_moments` orders by (start_s, id); a written-in row has to land where a
// refetch would have put it or the list reshuffles the next time one happens.
test('a created moment lands in the order the server would have returned', async () => {
  const client = freshClient()
  client.setQueryData(
    ['moments', 'bundle'],
    [moment({ id: 'a', start_s: 5 }), moment({ id: 'c', start_s: 30 })],
  )
  api.createMoment.mockResolvedValue(moment({ id: 'b', start_s: 12 }))

  const { result } = renderHook(() => useMomentMutations('bundle'), { wrapper: wrapper(client) })
  act(() => result.current.create.mutate({ file_id: 'f', start_s: 12, end_s: null }))

  await waitFor(() =>
    expect(
      (client.getQueryData(['moments', 'bundle']) as { id: string }[]).map((m) => m.id),
    ).toEqual(['a', 'b', 'c']),
  )
})

// Creating *with* tags does move the bundle's set (ADR-0025), so that path still
// refetches what it touched.
test('a created moment carrying tags still refreshes the bundle tags and counts', async () => {
  const client = freshClient()
  api.createMoment.mockResolvedValue(moment({ id: 'fresh', tag_ids: ['t1'] }))
  const invalidate = vi.spyOn(client, 'invalidateQueries')

  const { result } = renderHook(() => useMomentMutations('bundle'), { wrapper: wrapper(client) })
  act(() =>
    result.current.create.mutate({ file_id: 'f', start_s: 1, end_s: null, tag_ids: ['t1'] }),
  )

  await waitFor(() => expect(invalidate).toHaveBeenCalled())
  const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))
  expect(keys).toContain(JSON.stringify(['bundle-tags', 'bundle']))
  expect(keys).toContain(JSON.stringify(['tag-counts']))
})

// Forgetting a moment has no server-assigned anything to fold back in, so the
// row has no reason to outlive the click.
test('a forgotten moment leaves the list at once, and comes back if the write fails', async () => {
  const client = freshClient()
  client.setQueryData(['moments', 'bundle'], [moment({ id: 'keep' }), moment({ id: 'drop' })])
  let reject: (error: Error) => void = () => {}
  api.deleteMoment.mockReturnValue(new Promise((_resolve, r) => (reject = r)))

  const { result } = renderHook(() => useMomentMutations('bundle'), { wrapper: wrapper(client) })
  act(() => result.current.remove.mutate('drop'))

  // Gone before the write has answered.
  await waitFor(() =>
    expect(
      (client.getQueryData(['moments', 'bundle']) as { id: string }[]).map((m) => m.id),
    ).toEqual(['keep']),
  )

  await act(async () => {
    reject(new Error('nope'))
    await Promise.resolve()
  })
  await waitFor(() =>
    expect(
      (client.getQueryData(['moments', 'bundle']) as { id: string }[]).map((m) => m.id),
    ).toEqual(['keep', 'drop']),
  )
})
