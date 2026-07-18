import { afterEach, expect, test, vi } from 'vitest'

import { registerDesktopExitTask } from '../desktop/exitTasks'
import { createDesktopRuntime } from './desktop'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  onCloseRequested: vi.fn(),
  stopClose: vi.fn(),
  stopExit: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
  storeDelete: vi.fn(),
  storeSave: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
}))
vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: mocks.storeGet,
    set: mocks.storeSet,
    delete: mocks.storeDelete,
    save: mocks.storeSave,
  }),
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const mock of Object.values(mocks)) mock.mockReset()
})

test('synchronizes server-backed native menu availability', async () => {
  mocks.invoke.mockResolvedValue(undefined)
  const runtime = await createDesktopRuntime()

  await runtime.setServerAvailable(true)

  expect(mocks.invoke).toHaveBeenCalledWith('set_server_menu_enabled', { enabled: true })
})

test('exposes validated D3 mapping and host commands through the desktop seam', async () => {
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'get_library_mapping') return Promise.resolve('/Volumes/Media')
    if (command === 'locate_library_mapping') return Promise.resolve('/Volumes/Media')
    return Promise.resolve(undefined)
  })
  const runtime = await createDesktopRuntime()

  expect(runtime.platform.canRevealInFinder).toBe(true)
  expect(runtime.platform.canOpenWithDefaultApp).toBe(true)
  await expect(runtime.platform.getLibraryMapping('registry-id')).resolves.toBe('/Volumes/Media')
  await expect(runtime.platform.locateLibrary('registry-id', 'portable-uuid')).resolves.toBe(
    '/Volumes/Media',
  )
  await runtime.platform.revealFile('registry-id', 'Movies/movie.mp4')
  await runtime.platform.openFile('registry-id', 'Movies/movie.mp4')
  await runtime.platform.clearLibraryMapping('registry-id')

  expect(mocks.invoke).toHaveBeenCalledWith('locate_library_mapping', {
    libraryId: 'registry-id',
    libraryUuid: 'portable-uuid',
  })
  expect(mocks.invoke).toHaveBeenCalledWith('reveal_file', {
    libraryId: 'registry-id',
    relativePath: 'Movies/movie.mp4',
  })
  expect(mocks.invoke).toHaveBeenCalledWith('open_file', {
    libraryId: 'registry-id',
    relativePath: 'Movies/movie.mp4',
  })
  expect(mocks.invoke).toHaveBeenCalledWith('clear_library_mapping', {
    libraryId: 'registry-id',
  })
})

test('attaches bearer auth and media relay only to approved library scopes', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  mocks.storeGet.mockImplementation((key: string) => {
    if (key === 'deviceAuth')
      return Promise.resolve({
        serverUrl: 'http://nas.local:8000/cairndex',
        token: 'cdx_secret',
        libraryIds: ['lib-one'],
      })
    return Promise.resolve(null)
  })
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'configure_media_proxy')
      return Promise.resolve('http://127.0.0.1:49152/relay-secret')
    return Promise.resolve(undefined)
  })
  const runtime = await createDesktopRuntime()
  await runtime.configureServer('http://nas.local:8000/cairndex')

  await runtime.fetch('http://nas.local:8000/cairndex/api/v1/libraries')
  expect(fetchMock.mock.calls[0]?.[1]).toBeUndefined()

  await runtime.fetch('http://nas.local:8000/cairndex/api/v1/libraries/lib-one/bundles/browse')
  const scopedInit = fetchMock.mock.calls[1]?.[1] as RequestInit
  expect(new Headers(scopedInit.headers).get('Authorization')).toBe('Bearer cdx_secret')

  await runtime.fetch('http://nas.local:8000/cairndex/api/v1/libraries/lib-two/bundles/browse')
  expect(fetchMock.mock.calls[2]?.[1]).toBeUndefined()

  await runtime.fetch('https://cdn.example/media.mp4')
  expect(fetchMock.mock.calls[3]?.[1]).toBeUndefined()
  expect(
    runtime.assetUrl('http://nas.local:8000/cairndex/api/v1/libraries/lib-one/files/file/stream'),
  ).toBe('http://127.0.0.1:49152/relay-secret/api/v1/libraries/lib-one/files/file/stream')
  expect(
    runtime.assetUrl('http://nas.local:8000/cairndex/api/v1/libraries/lib-two/files/file/stream'),
  ).toBe('http://nas.local:8000/cairndex/api/v1/libraries/lib-two/files/file/stream')
  expect(runtime.hasDeviceAccess('lib-one')).toBe(true)
  expect(runtime.hasDeviceAccess('lib-two')).toBe(false)
  expect(mocks.invoke).toHaveBeenCalledWith('configure_media_proxy', {
    serverUrl: 'http://nas.local:8000/cairndex',
    token: 'cdx_secret',
    libraryIds: ['lib-one'],
  })
})

test('stores and clears one complete server-bound device grant', async () => {
  mocks.storeGet.mockResolvedValue(null)
  mocks.invoke.mockImplementation((command: string) => {
    if (command === 'configure_media_proxy')
      return Promise.resolve('http://127.0.0.1:49152/relay-secret')
    return Promise.resolve(undefined)
  })
  const runtime = await createDesktopRuntime()
  await runtime.configureServer('http://nas.local:8000')

  await runtime.saveDeviceToken('cdx_secret', ['lib-one', 'lib-one'])

  expect(mocks.storeSet).toHaveBeenCalledWith('deviceAuth', {
    serverUrl: 'http://nas.local:8000',
    token: 'cdx_secret',
    libraryIds: ['lib-one'],
  })
  expect(runtime.hasDeviceAccess('lib-one')).toBe(true)

  await runtime.clearDeviceToken()

  expect(mocks.storeDelete).toHaveBeenCalledWith('deviceAuth')
  expect(runtime.hasDeviceAccess('lib-one')).toBe(false)
  expect(mocks.invoke).toHaveBeenLastCalledWith('configure_media_proxy', {
    serverUrl: 'http://nas.local:8000',
    token: null,
    libraryIds: [],
  })
})

test('routes window close through ExitGate and awaits SPA exit tasks', async () => {
  let onClose!: (event: { preventDefault: () => void }) => Promise<void>
  let onExit!: () => Promise<void>
  mocks.onCloseRequested.mockImplementation(async (handler) => {
    onClose = handler
    return mocks.stopClose
  })
  mocks.listen.mockImplementation(async (_event, handler) => {
    onExit = handler
    return mocks.stopExit
  })

  const order: string[] = []
  let releaseTask!: () => void
  const stopTask = registerDesktopExitTask(
    () =>
      new Promise<void>((resolve) => {
        order.push('task')
        releaseTask = resolve
      }),
  )
  window.addEventListener('pagehide', () => order.push('pagehide'), { once: true })
  mocks.invoke.mockImplementation(async (command) => {
    if (command === 'finish_exit') order.push('finish')
  })

  const runtime = await createDesktopRuntime()
  const stopLifecycle = await runtime.listenLifecycle()
  const preventDefault = vi.fn()
  await onClose({ preventDefault })
  expect(preventDefault).toHaveBeenCalledOnce()
  expect(mocks.invoke).toHaveBeenCalledWith('request_exit')

  const exiting = onExit()
  await Promise.resolve()
  expect(order).toEqual(['task'])
  releaseTask()
  await exiting
  expect(order).toEqual(['task', 'pagehide', 'finish'])

  stopLifecycle()
  stopTask()
  expect(mocks.stopClose).toHaveBeenCalledOnce()
  expect(mocks.stopExit).toHaveBeenCalledOnce()
})
