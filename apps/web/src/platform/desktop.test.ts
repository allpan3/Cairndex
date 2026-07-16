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

test('attaches bearer auth only to the configured server and relays media URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetchMock)
  mocks.storeGet.mockImplementation((key: string) => {
    if (key === 'deviceAuth')
      return Promise.resolve({ serverUrl: 'http://nas.local:8000/cairndex', token: 'cdx_secret' })
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
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer cdx_secret')

  await runtime.fetch('https://cdn.example/media.mp4')
  expect(fetchMock.mock.calls[1]?.[1]).toBeUndefined()
  expect(
    runtime.assetUrl('http://nas.local:8000/cairndex/api/v1/libraries/lib/files/file/stream'),
  ).toBe('http://127.0.0.1:49152/relay-secret/api/v1/libraries/lib/files/file/stream')
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
