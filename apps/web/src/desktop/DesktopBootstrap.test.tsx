import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { DesktopBootstrap } from './DesktopBootstrap'
import { loadDesktopServerUrl, normalizeDesktopServerUrl, saveDesktopServerUrl } from './runtime'

vi.mock('./runtime', () => ({
  isDesktopHost: () => true,
  listenDesktopClose: vi.fn().mockResolvedValue(() => undefined),
  loadDesktopServerUrl: vi.fn(),
  normalizeDesktopServerUrl: vi.fn(),
  saveDesktopServerUrl: vi.fn(),
}))

const okResponse = () =>
  Promise.resolve(new Response(JSON.stringify({ status: 'ok' }), { status: 200 }))

beforeEach(() => {
  vi.mocked(loadDesktopServerUrl).mockReset()
  vi.mocked(normalizeDesktopServerUrl).mockReset()
  vi.mocked(saveDesktopServerUrl).mockReset()
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

// An unreachable saved server remains editable and never mounts content queries
test('shows a retryable error when the stored server is unavailable', async () => {
  vi.mocked(loadDesktopServerUrl).mockResolvedValue('http://offline.local:8000')
  vi.mocked(fetch).mockRejectedValue(new TypeError('failed'))

  render(
    <DesktopBootstrap>
      <div>Shared SPA</div>
    </DesktopBootstrap>,
  )

  expect(await screen.findByRole('alert')).toHaveTextContent('did not respond')
  expect(screen.getByLabelText('Server URL')).toHaveValue('http://offline.local:8000')
  expect(screen.queryByText('Shared SPA')).not.toBeInTheDocument()
})
