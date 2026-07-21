import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { BundleRead } from './client'
import { useUpdateBundle } from './hooks'

const api = vi.hoisted(() => ({ updateBundle: vi.fn() }))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  updateBundle: api.updateBundle,
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

beforeEach(() => api.updateBundle.mockReset())

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
