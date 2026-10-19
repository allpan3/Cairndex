import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { grouping, type GroupingStatus } from '../../api/grouping'
import { discovery } from '../../api/discovery'
import { useGroupingWorkspace } from './useGroupingWorkspace'

vi.mock('../../api/grouping', () => ({ grouping: vi.fn() }))
vi.mock('../../api/discovery', () => ({ discovery: vi.fn() }))

const ready: GroupingStatus = {
  id: 'synthetic-run',
  state: 'ready',
  phase: 'ready',
  revision: 1,
  accepting: null,
  error: null,
  files: 3,
  selected: 3,
  bundles: 1,
  uncertain: 0,
  command: null,
}
const clients: QueryClient[] = []
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return renderHook(() => useGroupingWorkspace('synthetic-library', vi.fn()), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  vi.resetAllMocks()
})

describe('private grouping operation lifecycle', () => {
  it('leaves recovered edits paused until their exact resume action', async () => {
    let resumed = false
    const requests: string[] = []
    vi.mocked(grouping).mockImplementation(async (_library, path, method = 'GET') => {
      requests.push(`${method} ${path}`)
      if (path === '/workspaces')
        return { items: [{ ...ready }], available_run: ready.id, next_cursor: null }
      if (path === `/workspaces/${ready.id}`)
        return { ...ready, command: resumed ? null : 'paused-edit' }
      if (path === '/commands/paused-edit/retry' && method === 'POST') {
        resumed = true
        return { id: 'paused-edit', state: 'queued' }
      }
      if (path === '/commands/paused-edit')
        return {
          id: 'paused-edit',
          state: resumed ? 'succeeded' : 'paused',
          result: null,
          error: resumed ? null : 'Explicit resume required',
        }
      throw new Error(`Unexpected test request ${path}`)
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.command.data?.state).toBe('paused'))
    expect(result.current.busy).toBe(true)
    expect(requests.filter((request) => request.endsWith('/retry'))).toEqual([])
    await act(() => result.current.resume())
    await waitFor(() => expect(result.current.busy).toBe(false))
    expect(requests.filter((request) => request.endsWith('/retry'))).toEqual([
      'POST /commands/paused-edit/retry',
    ])
  })

  it('polls the submitted operation without refetching the previous empty command key', async () => {
    let revision = 1
    const requests: string[] = []
    vi.mocked(grouping).mockImplementation(async (_library, path, method = 'GET', body) => {
      requests.push(`${method} ${path}`)
      if (path === '/workspaces') return { items: [], available_run: ready.id, next_cursor: null }
      if (path === `/workspaces/${ready.id}`) return { ...ready, revision }
      if (path.endsWith('/commands') && method === 'POST') {
        const value = body as { operation: string }
        revision = 2
        return { id: value.operation, state: 'queued' }
      }
      if (path.startsWith('/commands/'))
        return { id: path.slice('/commands/'.length), state: 'succeeded', result: { revision: 2 } }
      throw new Error(`Unexpected test request ${path}`)
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.status.data?.state).toBe('ready'))
    act(() =>
      result.current.edit({ action: 'rename', node: 'synthetic-node', title: 'Reviewed title' }),
    )
    await waitFor(() => expect(result.current.pending).toBeNull())
    await waitFor(() => expect(result.current.status.data?.revision).toBe(2))
    expect(requests.some((request) => request.startsWith('GET /commands/'))).toBe(true)
    expect(
      requests.some((request) => request.endsWith('/undefined') || request.endsWith('/null')),
    ).toBe(false)
  })

  it('recovers and cancels running verification after the dialog is reopened', async () => {
    vi.mocked(grouping).mockImplementation(async (_library, path) => {
      if (path === '/workspaces')
        return {
          items: [{ ...ready, state: 'editing' }],
          available_run: ready.id,
          next_cursor: null,
        }
      if (path === `/workspaces/${ready.id}`)
        return { ...ready, state: 'editing', phase: 'verification', command: 'retained-verify' }
      if (path === '/commands/retained-verify')
        return {
          id: 'retained-verify',
          state: 'running',
          phase: 'verification',
          result: { verification: 'retained-verify' },
        }
      throw new Error(`Unexpected test request ${path}`)
    })
    vi.mocked(discovery).mockResolvedValue({
      id: 'retained-verify',
      state: 'running',
      files: 1,
      verified: 0,
      bytes_read: 0,
      total_bytes: 400000,
    })
    const { result } = setup()
    await waitFor(() => expect(result.current.verification.data?.id).toBe('retained-verify'))
    await act(() => result.current.cancelVerification())
    expect(discovery).toHaveBeenCalledWith(
      'synthetic-library',
      '/verifications/retained-verify',
      'DELETE',
    )
    expect(result.current.busy).toBe(true)
  })
})
