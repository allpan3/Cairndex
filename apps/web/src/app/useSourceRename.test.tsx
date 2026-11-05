import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { PropsWithChildren } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { sourceRequest, type SourceRequest } from '../api/sourceOperations'
import { useSourceRename } from './useSourceRename'

vi.mock('../api/client', () => ({ fetchWriteMode: vi.fn() }))
vi.mock('../api/sourceOperations', () => ({ sourceRequest: vi.fn() }))

beforeEach(() => vi.resetAllMocks())

function setup() {
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  })
  cache.setQueryData(['source-write-mode', 'library'], { effective: false })
  const onError = vi.fn()
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={cache}>{children}</QueryClientProvider>
  )
  const hook = renderHook(({ available }) => useSourceRename('library', available, onError), {
    wrapper,
    initialProps: { available: true },
  })
  return { ...hook, cache, onError }
}

test('write-mode acknowledgement updates Rename without remounting; revocation blocks preparation', async () => {
  const { result, cache, rerender } = setup()
  expect(result.current.rename).toBeUndefined()
  act(() => cache.setQueryData(['source-write-mode', 'library'], { effective: true }))
  await waitFor(() => expect(result.current.rename).toBeTypeOf('function'))
  vi.mocked(sourceRequest).mockImplementation(async (_library, _path, _method, value) => ({
    id: (value as SourceRequest).operation,
  }))
  act(() => result.current.rename?.('Folder/amber.txt', 'gold.txt'))
  await waitFor(() => expect(result.current.prepare.isSuccess).toBe(true))
  expect(sourceRequest).toHaveBeenCalledExactlyOnceWith('library', '', 'POST', {
    operation: expect.any(String),
    action: 'rename',
    source: 'Folder/amber.txt',
    destination: 'Folder/gold.txt',
    collision: 'fail',
  })
  const request = result.current.prepare.variables!
  act(() => cache.setQueryData(['source-write-mode', 'library'], { effective: false }))
  await waitFor(() => expect(result.current.rename).toBeUndefined())
  act(() => result.current.queue(request))
  expect(sourceRequest).toHaveBeenCalledTimes(1)
  act(() => cache.setQueryData(['source-write-mode', 'library'], { effective: true }))
  rerender({ available: false })
  expect(result.current.rename).toBeUndefined()
})

test('a lost preparation reply retries the identical intent and never accepts automatically', async () => {
  const { result, cache, onError } = setup()
  act(() => cache.setQueryData(['source-write-mode', 'library'], { effective: true }))
  await waitFor(() => expect(result.current.rename).toBeTypeOf('function'))
  vi.mocked(sourceRequest)
    .mockRejectedValueOnce(new Error('Lost reply'))
    .mockResolvedValue({ id: 'saved' })
  act(() => result.current.rename?.('Folder', 'Renamed'))
  await waitFor(() => expect(result.current.prepare.isError).toBe(true))
  const request = result.current.prepare.variables!
  act(() => result.current.queue(request))
  await waitFor(() => expect(result.current.prepare.isSuccess).toBe(true))
  expect(vi.mocked(sourceRequest).mock.calls).toEqual([
    ['library', '', 'POST', request],
    ['library', '', 'POST', request],
  ])
  act(() => result.current.rename?.('Folder', '../moved'))
  expect(onError).toHaveBeenCalledWith('Enter a name without folder separators.')
  expect(sourceRequest).toHaveBeenCalledTimes(2)
})
