import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, test, vi } from 'vitest'

import type { FileRead } from './client'
import { useFileOperations } from './hooks'

const api = vi.hoisted(() => ({ trashEntries: vi.fn() }))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  trashEntries: api.trashEntries,
}))

/** The bundle-file fields this cache behavior depends on. */
function file(id: string, relativePath: string): FileRead {
  return { id, relative_path: relativePath } as FileRead
}

/** A query client shared with the hook under test. */
function wrapper(client: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

test('trash hides active bundle rows while the journaled move is still running and rolls back', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData<FileRead[]>(
    ['bundle-files', 'b1'],
    [file('f1', 'folder/slow.mp4'), file('f2', 'folder/keep.mp4')],
  )
  client.setQueryData<FileRead[]>(['bundle-files', 'b2'], [file('f3', 'folder/slow.mp4')])

  let rejectTrash: ((error: Error) => void) | undefined
  api.trashEntries.mockReturnValue(
    new Promise((_resolve, reject) => {
      rejectTrash = reject
    }),
  )
  const { result } = renderHook(() => useFileOperations(), { wrapper: wrapper(client) })

  act(() => result.current.trash.mutate(['folder/slow.mp4']))

  await waitFor(() => {
    expect(client.getQueryData<FileRead[]>(['bundle-files', 'b1'])?.map((row) => row.id)).toEqual([
      'f2',
    ])
    expect(client.getQueryData<FileRead[]>(['bundle-files', 'b2'])).toEqual([])
  })

  act(() => rejectTrash?.(new Error('share unavailable')))

  await waitFor(() => {
    expect(client.getQueryData<FileRead[]>(['bundle-files', 'b1'])?.map((row) => row.id)).toEqual([
      'f1',
      'f2',
    ])
    expect(client.getQueryData<FileRead[]>(['bundle-files', 'b2'])?.map((row) => row.id)).toEqual([
      'f3',
    ])
  })
})

test('trash restores only members the server could not move', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  client.setQueryData<FileRead[]>(
    ['bundle-files', 'b1'],
    [file('f1', 'folder/failed.mp4'), file('f2', 'folder/moved.mp4')],
  )
  api.trashEntries.mockResolvedValue({ failed_paths: ['folder/failed.mp4'] })
  const { result } = renderHook(() => useFileOperations(), { wrapper: wrapper(client) })

  await act(async () => {
    await result.current.trash.mutateAsync(['folder/failed.mp4', 'folder/moved.mp4'])
  })

  expect(client.getQueryData<FileRead[]>(['bundle-files', 'b1'])?.map((row) => row.id)).toEqual([
    'f1',
  ])
})
