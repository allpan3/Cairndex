import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { bundleFiles, deleteBundles, setCollectionMembership } from '../api/catalogOrganize'
import { sourceRequest, uploadSource, type SourceRequest } from '../api/sourceOperations'
import type { CatalogNotice } from './CatalogToast'
import { useSourceTasks, type NewTask } from './useSourceTasks'

let ids = 0
vi.mock('../api/catalog', () => ({ catalog: vi.fn(), operationId: () => `synthetic-${++ids}` }))
vi.mock('../api/catalogOrganize', () => ({
  bundleFiles: vi.fn(),
  deleteBundles: vi.fn(),
  setCollectionMembership: vi.fn(),
}))
vi.mock('../api/sourceOperations', async (original) => ({
  ...(await original<typeof import('../api/sourceOperations')>()),
  sourceRequest: vi.fn(),
  uploadSource: vi.fn(),
}))

// A server that prepares each operation at once; `taken` paths refuse the first try
function server(taken: string[] = []) {
  const posted: SourceRequest[] = []
  vi.mocked(sourceRequest).mockImplementation(async (_library, path, method, body) => {
    if (path === '' && method === 'POST') {
      const request = body as SourceRequest
      posted.push(request)
      const refused = taken.includes(request.destination!) && request.collision === 'fail'
      return {
        id: request.operation,
        state: refused ? 'interrupted' : 'prepared',
        error: refused ? 'Destination exists; choose Replace, Skip or Keep Both' : null,
        receipt: `receipt-${request.operation}`,
        request,
        review: null,
        progress: 0,
      }
    }
    if (path.endsWith('/accept')) {
      const request = posted.find((item) => path === `/${item.operation}/accept`)!
      const destination =
        request.collision === 'suffix' ? 'Trips/poster 2.jpg' : (request.destination ?? '')
      // A copy is catalogued at once; the review names the new file
      return {
        id: request.operation,
        state: 'succeeded',
        review: { destination, output_id: `file-${destination}`, destination_id: null },
      }
    }
    throw new Error(`unexpected ${method} ${path}`)
  })
  return posted
}

function copies(names: string[], finish: NewTask['finish']): NewTask {
  return {
    title: 'Copying',
    summary: 'Copied.',
    finish,
    items: names.map((name) => ({
      name,
      size: 10,
      file: new File(['synthetic'], name),
      request: {
        operation: `op-${name}`,
        action: 'copy',
        upload: `up-${name}`,
        destination: `Trips/${name}`,
        collision: 'fail',
      },
    })),
  }
}

function mount() {
  const notices: CatalogNotice[] = []
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(() => useSourceTasks('synthetic', (notice) => notices.push(notice)), {
    wrapper,
  })
  return { hook, notices }
}

beforeEach(() => {
  vi.mocked(uploadSource).mockReset().mockResolvedValue(undefined)
  vi.mocked(sourceRequest).mockReset()
  vi.mocked(bundleFiles).mockReset().mockResolvedValue('bundle-1')
  vi.mocked(setCollectionMembership).mockReset().mockResolvedValue(undefined)
  vi.mocked(deleteBundles).mockReset().mockResolvedValue(undefined)
})

test('copies become one new bundle in the chosen collection, then leave the sidebar', async () => {
  const posted = server()
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(
      copies(['clip.mp4', 'clip.srt'], {
        kind: 'new-bundle',
        title: 'Clip',
        collections: ['travel'],
      }),
    )
  })
  await waitFor(() => expect(notices).toHaveLength(1))
  expect(posted.map((request) => request.destination)).toEqual(['Trips/clip.mp4', 'Trips/clip.srt'])
  for (const request of posted)
    expect(sourceRequest).toHaveBeenCalledWith(
      'synthetic',
      `/${request.operation}/accept`,
      'POST',
      {
        receipt: `receipt-${request.operation}`,
      },
    )
  // By the identities the copies were catalogued with, not by path
  expect(bundleFiles).toHaveBeenCalledWith(
    'synthetic',
    ['file-Trips/clip.mp4', 'file-Trips/clip.srt'],
    null,
    'Clip',
  )
  expect(setCollectionMembership).toHaveBeenCalledWith('synthetic', ['bundle-1'], 'travel', true)
  expect(notices[0]).toMatchObject({ text: 'Created “Clip” with 2 files.' })
  expect(notices[0]!.action?.label).toBe('Undo')
  expect(hook.result.current.tasks).toHaveLength(0)
})

test('an occupied name waits in the sidebar, and Keep Both reuses the received bytes', async () => {
  const posted = server(['Trips/poster.jpg'])
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(copies(['poster.jpg'], { kind: 'none' }))
  })
  await waitFor(() => expect(hook.result.current.tasks[0]?.items[0]?.state.kind).toBe('exists'))
  expect(notices).toHaveLength(0)
  const id = hook.result.current.tasks[0]!.id
  act(() => hook.result.current.decide(id, 0, 'suffix'))
  await waitFor(() => expect(notices).toHaveLength(1))
  const [first, retry] = posted
  expect(retry).toMatchObject({ upload: first!.upload, collision: 'suffix' })
  expect(retry!.operation).not.toBe(first!.operation)
  expect(uploadSource).toHaveBeenCalledTimes(1)
})

test('a failed copy stays with Try Again and makes no bundle', async () => {
  vi.mocked(uploadSource).mockRejectedValueOnce(new Error('The server went away'))
  server()
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(
      copies(['clip.mp4'], { kind: 'new-bundle', title: 'Clip', collections: [] }),
    )
  })
  await waitFor(() => expect(hook.result.current.tasks[0]?.items[0]?.state.kind).toBe('failed'))
  expect(bundleFiles).not.toHaveBeenCalled()
  act(() => hook.result.current.resume(hook.result.current.tasks[0]!.id))
  await waitFor(() => expect(notices).toHaveLength(1))
  expect(bundleFiles).toHaveBeenCalledTimes(1)
})

test('Undo of a new bundle moves its copies to the Trash, then removes the bundle', async () => {
  const posted = server()
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(
      copies(['clip.mp4', 'clip.srt'], { kind: 'new-bundle', title: 'Clip', collections: [] }),
    )
  })
  await waitFor(() => expect(notices).toHaveLength(1))
  act(() => notices[0]!.action!.run())
  await waitFor(() => expect(notices).toHaveLength(2))
  expect(posted.slice(2).map(({ action, source }) => ({ action, source }))).toEqual([
    { action: 'trash', source: 'Trips/clip.mp4' },
    { action: 'trash', source: 'Trips/clip.srt' },
  ])
  expect(deleteBundles).toHaveBeenCalledWith('synthetic', ['bundle-1'])
  expect(notices[1]).toMatchObject({ text: 'Moved 2 files to the Trash.' })
  expect(notices[1]!.action).toBeUndefined()
})
