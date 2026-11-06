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
    if (method === 'DELETE') return undefined
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
  await act(() => hook.result.current.decide(id, 0, 'suffix'))
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

test('a changed collision name cancels the saved intent and reuses its upload', async () => {
  const posted = server(['Trips/poster.jpg'])
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(copies(['poster.jpg'], { kind: 'none' }))
  })
  await waitFor(() => expect(hook.result.current.tasks[0]?.items[0]?.state.kind).toBe('exists'))
  const id = hook.result.current.tasks[0]!.id
  await act(() => hook.result.current.rename(id, 0, 'other.jpg'))
  await waitFor(() => expect(notices).toHaveLength(1))
  expect(sourceRequest).toHaveBeenCalledWith('synthetic', '/op-poster.jpg', 'DELETE')
  expect(posted[1]).toMatchObject({ destination: 'Trips/other.jpg', upload: 'up-poster.jpg' })
  expect(uploadSource).toHaveBeenCalledTimes(1)
})

test('dismiss cancels persisted collisions and keeps failed recovery visible', async () => {
  server(['Trips/poster.jpg'])
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(copies(['poster.jpg'], { kind: 'none' }))
  })
  await waitFor(() => expect(hook.result.current.tasks[0]?.items[0]?.state.kind).toBe('exists'))
  const id = hook.result.current.tasks[0]!.id
  vi.mocked(sourceRequest).mockRejectedValueOnce(
    new Error('Files have already changed; finish recovery before cancelling'),
  )
  await act(() => hook.result.current.dismiss(id))
  expect(hook.result.current.tasks).toHaveLength(1)
  expect(notices[0]?.alert).toBe(true)
  await act(() => hook.result.current.dismiss(id))
  expect(hook.result.current.tasks).toHaveLength(0)
  expect(sourceRequest).toHaveBeenLastCalledWith('synthetic', '/op-poster.jpg', 'DELETE')
})

test('upload reports received bytes before the operation is queued', async () => {
  let finish!: () => void
  vi.mocked(uploadSource).mockImplementation(
    async (_library, _upload, _file, _signal, progress) => {
      progress?.(4)
      await new Promise<void>((resolve) => {
        finish = resolve
      })
    },
  )
  server()
  const { hook, notices } = mount()
  act(() => {
    hook.result.current.start(copies(['clip.mp4'], { kind: 'none' }))
  })
  await waitFor(() => expect(hook.result.current.tasks[0]?.items[0]?.uploaded).toBe(4))
  expect(sourceRequest).not.toHaveBeenCalled()
  expect(hook.result.current.tasks[0]?.items[0]?.state).toMatchObject({ kind: 'sending', bytes: 4 })
  await act(async () => {
    finish()
  })
  await waitFor(() => expect(notices).toHaveLength(1))
})

test('an occupied rename rejects the editor and retires its intent without a task', async () => {
  const { renameTask } = await import('./sourceActions')
  server(['Trips/Taken'])
  const { hook, notices } = mount()
  await act(async () => {
    await expect(hook.result.current.name(renameTask('Trips/Vacant', 'Taken'))).rejects.toThrow(
      'This name is already in use.',
    )
  })
  expect(hook.result.current.tasks).toEqual([])
  expect(notices).toEqual([])
  expect(sourceRequest).toHaveBeenCalledWith('synthetic', expect.any(String), 'DELETE')
  await act(async () => {
    await hook.result.current.name(renameTask('Trips/Vacant', 'Available'))
  })
  expect(hook.result.current.tasks).toEqual([])
  expect(notices[0]?.action?.label).toBe('Undo')
})

test('a naming collision after mutation started keeps recovery instead of cancelling', async () => {
  const { renameTask } = await import('./sourceActions')
  vi.mocked(sourceRequest).mockResolvedValue({
    id: 'started',
    state: 'interrupted',
    error: 'Destination exists',
    result: { started: true },
  })
  const { hook } = mount()
  await act(async () => {
    await expect(hook.result.current.name(renameTask('Trips/Vacant', 'Taken'))).rejects.toThrow(
      'Destination exists',
    )
  })
  expect(hook.result.current.tasks[0]?.inline).toBe(false)
  expect(sourceRequest).not.toHaveBeenCalledWith('synthetic', expect.any(String), 'DELETE')
})
