import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { BundleRead } from './client'
import { HttpError } from './client'
import { useBundle, useBundleFiles, useUpdateBundle } from './hooks'

const api = vi.hoisted(() => ({
  updateBundle: vi.fn(),
  fetchBundle: vi.fn(),
  fetchBundleFiles: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  updateBundle: api.updateBundle,
  fetchBundle: api.fetchBundle,
  fetchBundleFiles: api.fetchBundleFiles,
}))

// Minimal bundle state for metadata-mutation cache tests
function bundle(coverFileId: string, version = 1): BundleRead {
  return {
    id: 'bundle',
    title: 'Movie',
    notes: [],
    rating: 0,
    cover_file_id: coverFileId,
    resume_file_id: 'first',
    grouping_state: 'confirmed',
    grouping_source: 'manual',
    created_at: '2026-07-21T00:00:00Z',
    imported_at: '2026-07-21T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
    version,
  }
}

// Provide one isolated query cache per hook test
function wrapper(client: QueryClient) {
  // Bind the hook to the cache under test
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  api.updateBundle.mockReset()
  api.fetchBundle.mockReset()
  api.fetchBundleFiles.mockReset()
})

test('optimistically updates the cover and adopts the PATCH response without refetching detail', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { throwOnError: false } },
  })
  const current = bundle('first')
  const updated = bundle('second', 2)
  client.setQueryData(['bundle', 'bundle'], current)
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  api.updateBundle.mockImplementation(async () => {
    expect(client.getQueryData<BundleRead>(['bundle', 'bundle'])?.cover_file_id).toBe('second')
    return updated
  })
  const { result } = renderHook(() => useUpdateBundle('bundle', 1), {
    wrapper: wrapper(client),
  })

  await act(() => result.current.mutateAsync({ cover_file_id: 'second' }))

  expect(client.getQueryData(['bundle', 'bundle'])).toEqual(updated)
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['browse'] })
  expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['bundle', 'bundle'] })
})

test('a bundle the server no longer has resolves to gone, not to an error', async () => {
  // Forgotten, swept by a scan, or deleted in another window: the pane pointing
  // at it must be able to say so rather than keep its last-known state (owner,
  // 2026-08-24). `null` is that answer; `undefined` still means "not loaded".
  api.fetchBundle.mockRejectedValue(new HttpError(404, 'bundle not found'))
  api.fetchBundleFiles.mockRejectedValue(new HttpError(404, 'bundle not found'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const bundle = renderHook(() => useBundle('gone'), { wrapper: wrapper(client) })
  const files = renderHook(() => useBundleFiles('gone'), { wrapper: wrapper(client) })

  await waitFor(() => expect(bundle.result.current.isSuccess).toBe(true))
  await waitFor(() => expect(files.result.current.isSuccess).toBe(true))
  expect(bundle.result.current.data).toBeNull()
  expect(bundle.result.current.error).toBeNull()
  expect(files.result.current.data).toEqual([])
})

test('any other failure is still a failure', async () => {
  api.fetchBundle.mockRejectedValue(new HttpError(500, 'server on fire'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const bundle = renderHook(() => useBundle('b1'), { wrapper: wrapper(client) })

  await waitFor(() => expect(bundle.result.current.isError).toBe(true))
  expect(bundle.result.current.data).toBeUndefined()
})
