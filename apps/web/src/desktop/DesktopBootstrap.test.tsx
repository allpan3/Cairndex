import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { DesktopBootstrap } from './DesktopBootstrap'
import {
  listenDesktopLifecycle,
  listenDesktopMenu,
  loadDesktopServerUrl,
  normalizeDesktopServerUrl,
  saveDesktopServerUrl,
  setDesktopServerAvailable,
} from './runtime'

vi.mock('./runtime', () => ({
  listenDesktopLifecycle: vi.fn().mockResolvedValue(() => undefined),
  listenDesktopMenu: vi.fn().mockResolvedValue(() => undefined),
  loadDesktopServerUrl: vi.fn(),
  normalizeDesktopServerUrl: vi.fn(),
  saveDesktopServerUrl: vi.fn(),
  setDesktopServerAvailable: vi.fn().mockResolvedValue(undefined),
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
  vi.mocked(listenDesktopLifecycle)
    .mockReset()
    .mockResolvedValue(() => undefined)
  vi.mocked(listenDesktopMenu)
    .mockReset()
    .mockResolvedValue(() => undefined)
  vi.mocked(loadDesktopServerUrl).mockReset()
  vi.mocked(normalizeDesktopServerUrl).mockReset()
  vi.mocked(saveDesktopServerUrl).mockReset()
  vi.mocked(setDesktopServerAvailable).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(okResponse))
})

// A verified stored URL bypasses first-run without forking the SPA
test('mounts the shared app with a reachable stored server', async () => {
  vi.mocked(loadDesktopServerUrl).mockResolvedValue('http://127.0.0.1:8000')

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  expect(await screen.findByText('Shared SPA')).toBeInTheDocument()
  expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:8000/api/v1/health', expect.anything())
  expect(setDesktopServerAvailable).toHaveBeenLastCalledWith(true)
})

// First run validates, probes, and persists before revealing the shared SPA
test('stores a verified first-run server URL', async () => {
  vi.mocked(loadDesktopServerUrl).mockResolvedValue(null)
  vi.mocked(normalizeDesktopServerUrl).mockResolvedValue('http://nas.local:8000')

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  const input = await screen.findByLabelText('Server URL')
  fireEvent.change(input, { target: { value: 'http://nas.local:8000/' } })
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }))

  await waitFor(() => expect(saveDesktopServerUrl).toHaveBeenCalledWith('http://nas.local:8000'))
  expect(await screen.findByText('Shared SPA')).toBeInTheDocument()
})

// A generic HTTP 200 endpoint is not persisted as a compatible Cairndex server
test('rejects a server without the required Cairndex capabilities', async () => {
  vi.mocked(loadDesktopServerUrl).mockResolvedValue(null)
  vi.mocked(normalizeDesktopServerUrl).mockResolvedValue('http://other.local:8000')
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
  expect(saveDesktopServerUrl).not.toHaveBeenCalled()
  expect(screen.queryByText('Shared SPA')).not.toBeInTheDocument()
})

// An unreachable saved server remains editable and never mounts content queries
test('keeps server settings actionable when the stored server is unavailable', async () => {
  let menuHandler: ((action: 'settings') => void) | undefined
  vi.mocked(listenDesktopMenu).mockImplementation(async (handler) => {
    menuHandler = handler
    return () => undefined
  })
  vi.mocked(loadDesktopServerUrl).mockResolvedValue('http://offline.local:8000')
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
  expect(setDesktopServerAvailable).toHaveBeenLastCalledWith(false)

  input.blur()
  act(() => menuHandler?.('settings'))
  expect(input).toHaveFocus()
  expect(input).toHaveSelection(input.getAttribute('value') ?? '')
})
