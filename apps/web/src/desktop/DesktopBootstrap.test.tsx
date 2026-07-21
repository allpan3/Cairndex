import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { resetConnectionsForTests } from './connections'
import { DesktopBootstrap } from './DesktopBootstrap'
import {
  configureHostServer,
  initializeHostPlatform,
  listenHostLifecycle,
  listenHostMenu,
  loadHostServerUrl,
  normalizeHostServerUrl,
  saveHostServerUrl,
  setHostServerAvailable,
} from '../platform'

vi.mock('../platform', () => ({
  configureHostServer: vi.fn().mockResolvedValue(undefined),
  hostFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  initializeHostPlatform: vi.fn().mockResolvedValue({ kind: 'desktop' }),
  listenHostLifecycle: vi.fn().mockResolvedValue(() => undefined),
  listenHostMenu: vi.fn().mockResolvedValue(() => undefined),
  loadHostServerUrl: vi.fn(),
  // D6: the bootstrap resolves its server through the connections store, which
  // migrates the legacy `loadHostServerUrl` value on first read.
  loadHostConnections: vi.fn().mockResolvedValue(null),
  saveHostConnections: vi.fn().mockResolvedValue(undefined),
  startHostLocalServer: vi.fn(),
  openHostLibraryFolder: vi.fn().mockResolvedValue(null),
  hostOperationErrorMessage: (error: unknown) =>
    error instanceof Error ? error.message : 'failed',
  normalizeHostServerUrl: vi.fn(),
  resolveHostAssetUrl: (value: string) => value,
  saveHostServerUrl: vi.fn(),
  setHostServerAvailable: vi.fn().mockResolvedValue(undefined),
}))

const okResponse = () =>
  Promise.resolve(
    new Response(
      JSON.stringify({
        status: 'ok',
        app_name: 'Cairndex',
        environment: 'test',
        api_features: ['pairing', 'progress'],
      }),
      { status: 200 },
    ),
  )

beforeEach(() => {
  resetConnectionsForTests()
  vi.mocked(configureHostServer).mockReset().mockResolvedValue(undefined)
  vi.mocked(initializeHostPlatform)
    .mockReset()
    .mockResolvedValue({ kind: 'desktop' } as never)
  vi.mocked(listenHostLifecycle)
    .mockReset()
    .mockResolvedValue(() => undefined)
  vi.mocked(listenHostMenu)
    .mockReset()
    .mockResolvedValue(() => undefined)
  vi.mocked(loadHostServerUrl).mockReset()
  vi.mocked(normalizeHostServerUrl).mockReset()
  vi.mocked(saveHostServerUrl).mockReset()
  vi.mocked(setHostServerAvailable).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(okResponse))
})

// A verified stored URL bypasses first-run without forking the SPA
test('mounts the shared app with a reachable stored server', async () => {
  vi.mocked(loadHostServerUrl).mockResolvedValue('http://127.0.0.1:8000')

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  expect(await screen.findByText('Shared SPA')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8000/api/v1/health', expect.anything())
  // `localToken: null` is the remote case; the sidecar's server-wide bearer is
  // only passed for the managed local connection (plan 3 §7.1).
  expect(configureHostServer).toHaveBeenCalledWith('http://127.0.0.1:8000', { localToken: null })
  expect(setHostServerAvailable).toHaveBeenLastCalledWith(true)
})

// First run validates, probes, and persists before revealing the shared SPA
test('stores a verified first-run server URL', async () => {
  vi.mocked(loadHostServerUrl).mockResolvedValue(null)
  vi.mocked(normalizeHostServerUrl).mockResolvedValue('http://nas.local:8000')

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  const input = await screen.findByLabelText('Server URL')
  fireEvent.change(input, { target: { value: 'http://nas.local:8000/' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => expect(saveHostServerUrl).toHaveBeenCalledWith('http://nas.local:8000'))
  expect(await screen.findByText('Shared SPA')).toBeInTheDocument()
})

// A generic HTTP 200 endpoint is not persisted as a compatible Cairndex server
test('rejects a server without the required Cairndex capabilities', async () => {
  vi.mocked(loadHostServerUrl).mockResolvedValue(null)
  vi.mocked(normalizeHostServerUrl).mockResolvedValue('http://other.local:8000')
  vi.mocked(fetch).mockResolvedValue(
    new Response(JSON.stringify({ status: 'ok', app_name: 'Other', api_features: [] }), {
      status: 200,
    }),
  )

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  fireEvent.change(await screen.findByLabelText('Server URL'), {
    target: { value: 'http://other.local:8000' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('not a compatible Cairndex server')
  expect(saveHostServerUrl).not.toHaveBeenCalled()
  expect(screen.queryByText('Shared SPA')).not.toBeInTheDocument()
})

// An unreachable saved server remains editable and never mounts content queries
test('keeps server settings actionable when the stored server is unavailable', async () => {
  let menuHandler: ((action: 'settings') => void) | undefined
  vi.mocked(listenHostMenu).mockImplementation(async (handler) => {
    menuHandler = handler
    return () => undefined
  })
  vi.mocked(loadHostServerUrl).mockResolvedValue('http://offline.local:8000')
  vi.mocked(fetch).mockRejectedValue(new TypeError('failed'))

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  expect(await screen.findByRole('alert')).toHaveTextContent('did not respond')
  const input = screen.getByLabelText('Server URL')
  expect(input).toHaveValue('http://offline.local:8000')
  expect(screen.queryByText('Shared SPA')).not.toBeInTheDocument()
  expect(setHostServerAvailable).toHaveBeenLastCalledWith(false)

  input.blur()
  act(() => menuHandler?.('settings'))
  expect(input).toHaveFocus()
  expect(input).toHaveSelection(input.getAttribute('value') ?? '')
})
