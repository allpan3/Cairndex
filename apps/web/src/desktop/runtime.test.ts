import { afterEach, expect, test, vi } from 'vitest'

import { registerDesktopExitTask } from './exitTasks'
import { listenDesktopLifecycle } from './runtime'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  onCloseRequested: vi.fn(),
  stopClose: vi.fn(),
  stopExit: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ onCloseRequested: mocks.onCloseRequested }),
}))
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn() }))

afterEach(() => {
  vi.restoreAllMocks()
  for (const mock of Object.values(mocks)) mock.mockReset()
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

  const stopLifecycle = await listenDesktopLifecycle()
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
