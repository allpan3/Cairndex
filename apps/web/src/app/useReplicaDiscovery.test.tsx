import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { discovery } from '../api/discovery'
import { operationId } from '../api/catalog'
import { useReplicaDiscovery } from './useReplicaDiscovery'

vi.mock('../api/catalog', () => ({ operationId: vi.fn() }))
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
  vi.mocked(operationId)
    .mockReset()
    .mockReturnValueOnce('synthetic-run')
    .mockReturnValue('next-run')
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

test('initial indexing retains private discoveries without opening a grouping decision', async () => {
  serve([candidate])
  const { result } = setup()
  await waitFor(() => expect(result.current.canStart).toBe(true))

  await act(() => result.current.start({ openReview: false }))

  await waitFor(() => expect(result.current.finished).not.toBeNull())
  expect(result.current.pending).toBe(true)
  expect(result.current.open).toBe(false)
  act(() => result.current.setOpen(true))
  expect(result.current.open).toBe(true)
})

test('a delayed initial result cannot clear or open a later manual Update', async () => {
  let latest: string | null = null
  let finishManual = false
  let release: ((value: unknown) => void) | undefined
  const firstCandidates = new Promise((resolve) => {
    release = resolve
  })
  vi.mocked(discovery).mockImplementation(async (_library, path, method, body) => {
    if (method === 'POST') {
      latest = (body as { operation: string }).operation
      return {}
    }
    if (path === '/status')
      return {
        id: latest,
        state:
          latest === null
            ? 'idle'
            : latest === 'synthetic-run' || finishManual
              ? 'succeeded'
              : 'running',
        observed: 4,
      }
    if (path.startsWith('/candidates')) {
      if (latest === 'synthetic-run') return firstCandidates
      return { items: latest ? [candidate] : [], next_cursor: null }
    }
    return { items: [], next_cursor: null }
  })
  const { result } = setup()
  await waitFor(() => expect(result.current.canStart).toBe(true))
  await act(() => result.current.start({ openReview: false }))
  await waitFor(() => expect(result.current.run.data?.state).toBe('succeeded'))
  await act(() => result.current.start())
  await waitFor(() => expect(result.current.run.data?.id).toBe('next-run'))
  await act(async () => release?.({ items: [candidate], next_cursor: null }))
  expect(result.current.open).toBe(false)
  expect(result.current.finished).toBeNull()
  finishManual = true
  await act(() => result.current.run.refetch())
  await waitFor(() => expect(result.current.open).toBe(true))
  expect(result.current.finished?.id).toBe('next-run')
})
