import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { discovery } from '../api/discovery'
import { useReplicaDiscovery } from './useReplicaDiscovery'

vi.mock('../api/catalog', () => ({ operationId: () => 'synthetic-run' }))
vi.mock('../api/discovery', () => ({ discovery: vi.fn() }))

const candidate = { id: 'candidate-1', path: 'Novel/new.png', body: {} }

// The server answers with a run that this window started and has finished
function serve(candidates: unknown[]) {
  let started = false
  vi.mocked(discovery).mockImplementation(async (_library, path, method) => {
    if (method === 'POST') {
      started = true
      return {}
    }
    if (path === '/status')
      return started
        ? { id: 'synthetic-run', state: 'succeeded', observed: 4, repaired: 0 }
        : { state: 'idle' }
    if (path.startsWith('/candidates'))
      return { items: started ? candidates : [], next_cursor: null }
    return { items: [], next_cursor: null }
  })
}

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useReplicaDiscovery('library', true, () => undefined), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}

beforeEach(() => {
  vi.mocked(discovery).mockReset()
})

// As v0.2.1 opened grouping review when its Update left suggestions
test('an Update this window started opens the review when it leaves discoveries', async () => {
  serve([candidate])
  const { result } = setup()
  await waitFor(() => expect(result.current.canStart).toBe(true))

  await act(() => result.current.start())

  await waitFor(() => expect(result.current.open).toBe(true))
  expect(result.current.finished).toMatchObject({ id: 'synthetic-run', observed: 4 })
  act(() => result.current.clearFinished())
  expect(result.current.finished).toBeNull()
})

test('an Update that leaves nothing to decide reports without opening the review', async () => {
  serve([])
  const { result } = setup()
  await waitFor(() => expect(result.current.canStart).toBe(true))

  await act(() => result.current.start())

  await waitFor(() => expect(result.current.finished).not.toBeNull())
  expect(result.current.open).toBe(false)
})
