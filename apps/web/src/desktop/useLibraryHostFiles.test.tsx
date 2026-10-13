import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import type { PropsWithChildren } from 'react'
import type { LibraryRead } from '../api/client'
import { advanceConnectionScope, advanceLibraryScope } from '../api/requestScope'
import { libraryMappingKey, useLibraryHostFiles } from './useLibraryHostFiles'

const host = vi.hoisted(() => ({
  kind: 'desktop',
  canRevealInFinder: true,
  canOpenWithDefaultApp: true,
  canDragOutFiles: true,
  getLibraryMapping: vi.fn(),
  revealFile: vi.fn(),
  openFile: vi.fn(),
  startFileDrag: vi.fn(),
  adopt: vi.fn(),
  connection: 'remote',
}))
vi.mock('../platform', () => ({
  getHostPlatform: () => host,
  getHostLabels: () => ({ revealFile: 'Reveal in Finder', openFile: 'Open in Default App' }),
  adoptHostLibraryMapping: host.adopt,
  hostOperationErrorMessage: (reason: Error) => reason.message,
}))
vi.mock('./connections', () => ({ getActiveConnection: () => ({ kind: host.connection }) }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return {
    client,
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  }
}
beforeEach(() => {
  vi.clearAllMocks()
  advanceConnectionScope('synthetic-server-a')
  advanceLibraryScope()
  host.kind = 'desktop'
  host.connection = 'remote'
  host.getLibraryMapping.mockResolvedValue('/synthetic/library')
  host.openFile.mockResolvedValue(undefined)
  host.revealFile.mockResolvedValue(undefined)
  host.startFileDrag.mockResolvedValue(undefined)
})

test('web and unmapped libraries do not offer host actions', async () => {
  host.kind = 'web'
  const web = renderHook(() => useLibraryHostFiles('library'), setup())
  expect(web.result.current.onRevealFile).toBeUndefined()
  expect(host.getLibraryMapping).not.toHaveBeenCalled()
  web.unmount()
  host.kind = 'desktop'
  host.getLibraryMapping.mockResolvedValue(null)
  const native = renderHook(() => useLibraryHostFiles('library'), setup())
  await waitFor(() => expect(native.result.current.pending).toBe(false))
  expect(native.result.current.onOpenFile).toBeUndefined()
})

test('native actions pass relative paths and deduplicate drag selection', async () => {
  const view = renderHook(() => useLibraryHostFiles('library'), setup())
  await waitFor(() => expect(view.result.current.mapped).toBe(true))
  act(() => {
    view.result.current.onOpenFile!('Clips/amber.mkv')
    view.result.current.onRevealFile!('Clips/amber.mkv')
    view.result.current.onStartFileDrag!(['Clips/amber.mkv', 'Clips/blue.png', 'Clips/amber.mkv'])
  })
  expect(host.openFile).toHaveBeenCalledWith('library', 'Clips/amber.mkv')
  expect(host.revealFile).toHaveBeenCalledWith('library', 'Clips/amber.mkv')
  expect(host.startFileDrag).toHaveBeenCalledWith([
    { libraryId: 'library', relativePath: 'Clips/amber.mkv' },
    { libraryId: 'library', relativePath: 'Clips/blue.png' },
  ])
})

test('a late mapping cannot enable the same registry ID on another server', async () => {
  const delayed = deferred<string>()
  host.getLibraryMapping.mockReturnValueOnce(delayed.promise).mockResolvedValue(null)
  const { client, wrapper } = setup()
  const view = renderHook(() => useLibraryHostFiles('library'), { wrapper })
  const oldKey = libraryMappingKey('library')
  act(() => advanceConnectionScope('synthetic-server-b'))
  view.rerender()
  await act(async () => delayed.resolve('/synthetic/old-server'))
  await waitFor(() => expect(view.result.current.pending).toBe(false))
  expect(view.result.current.mapped).toBe(false)
  expect(client.getQueryData(oldKey)).toBeUndefined()
  expect(client.getQueryData(libraryMappingKey('library'))).toBeNull()
})

test('local adoption retains its original scope when the server changes', async () => {
  host.connection = 'local'
  host.getLibraryMapping.mockResolvedValue(null)
  const delayed = deferred<string>()
  host.adopt.mockReturnValue(delayed.promise)
  const { client, wrapper } = setup()
  const registration = {
    library_uuid: 'synthetic-uuid',
    root_path: '/synthetic/library',
  } as LibraryRead
  const view = renderHook(() => useLibraryHostFiles('library', registration), { wrapper })
  await waitFor(() =>
    expect(host.adopt).toHaveBeenCalledWith('library', 'synthetic-uuid', '/synthetic/library'),
  )
  act(() => {
    host.connection = 'remote'
    advanceConnectionScope('synthetic-server-b')
  })
  view.rerender()
  await act(async () => delayed.resolve('/synthetic/library'))
  await waitFor(() => expect(view.result.current.pending).toBe(false))
  expect(view.result.current.mapped).toBe(false)
  expect(client.getQueryData(libraryMappingKey('library'))).toBeNull()
})

test('native failure is shown only for the accepted library scope', async () => {
  const delayed = deferred<void>()
  host.openFile.mockReturnValue(delayed.promise)
  const view = renderHook(() => useLibraryHostFiles('library'), setup())
  await waitFor(() => expect(view.result.current.mapped).toBe(true))
  act(() => view.result.current.onOpenFile!('amber.mkv'))
  act(() => advanceLibraryScope())
  await act(async () => delayed.reject(new Error('Volume not mounted')))
  expect(view.result.current.error).toBe('')
})

test('a mapped mount failure is visible and can be dismissed', async () => {
  host.revealFile.mockRejectedValue(new Error('Volume not mounted'))
  const view = renderHook(() => useLibraryHostFiles('library'), setup())
  await waitFor(() => expect(view.result.current.mapped).toBe(true))
  act(() => view.result.current.onRevealFile!('amber.mkv'))
  await waitFor(() => expect(view.result.current.error).toBe('Volume not mounted'))
  act(() => view.result.current.dismissError())
  expect(view.result.current.error).toBe('')
})
