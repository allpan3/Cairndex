import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { fetchBundle, setActiveLibraryId, setApiBaseUrl } from './client'
import { replicaRequest, draftKey } from './replicas'
import { useScopedMutation } from './useScopedMutation'

afterEach(() => {
  vi.unstubAllGlobals()
  setApiBaseUrl(null)
  setActiveLibraryId(null)
})

// A response body may arrive after a switch even when its headers arrived beforehand
test('rejects delayed content and replica continuations across a round-trip switch', async () => {
  setApiBaseUrl('https://one.example', 'remote:one')
  setActiveLibraryId('same-library')
  let finish!: (response: Response) => void
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve
        }),
    ),
  )
  const pending = fetchBundle('same-bundle')
  setApiBaseUrl('https://two.example', 'remote:two')
  setApiBaseUrl('https://one.example', 'remote:one')
  finish(new Response(JSON.stringify({ id: 'same-bundle' })))
  await expect(pending).rejects.toThrow('changed')
  const replica = replicaRequest('same-library', '/status')
  setActiveLibraryId('another-library')
  finish(new Response(JSON.stringify({ status: 'saved' })))
  await expect(replica).rejects.toThrow('changed')
})

test('does not run a mutation delayed by optimistic cancellation after library switching', async () => {
  setActiveLibraryId('one')
  let finish!: () => void
  const mutation = vi.fn().mockResolvedValue('saved')
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const { result } = renderHook(
    () =>
      useScopedMutation({
        mutationFn: mutation,
        onMutate: () =>
          new Promise<void>((resolve) => {
            finish = resolve
          }),
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  let pending!: Promise<unknown>
  act(() => {
    pending = result.current.mutateAsync(undefined)
  })
  await vi.waitFor(() => expect(finish).toBeDefined())
  setActiveLibraryId('two')
  finish()
  await expect(pending).rejects.toThrow('changed')
  expect(mutation).not.toHaveBeenCalled()
  client.clear()
})

test('uses stable local draft keys across sidecar ports and distinct remote keys for duplicate IDs', () => {
  setApiBaseUrl('http://127.0.0.1:51001', 'local')
  const local = draftKey('same-library', 'same-bundle', 'editor')
  setApiBaseUrl('http://127.0.0.1:51002', 'local')
  expect(draftKey('same-library', 'same-bundle', 'editor')).toBe(local)
  setApiBaseUrl('https://one.example', 'remote:one')
  const one = draftKey('same-library', 'same-bundle', 'editor')
  setApiBaseUrl('https://two.example', 'remote:two')
  expect(draftKey('same-library', 'same-bundle', 'editor')).not.toBe(one)
})
