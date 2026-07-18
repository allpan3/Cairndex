import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { SettingsDialog } from './SettingsDialog'

const platformMocks = vi.hoisted(() => ({
  saveDeviceToken: vi.fn(),
  clearDeviceToken: vi.fn(),
  hasDeviceToken: vi.fn(() => false),
}))

vi.mock('../platform', () => ({
  getHostLabels: () => ({
    revealFile: 'Reveal in Finder',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Mac',
    deviceName: 'Cairndex Desktop for Mac',
  }),
  getHostPlatform: () => ({ kind: 'desktop' }),
  hasHostDeviceToken: platformMocks.hasDeviceToken,
  hostFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostAssetUrl: (value: string) => value,
  saveHostDeviceToken: platformMocks.saveDeviceToken,
  clearHostDeviceToken: platformMocks.clearDeviceToken,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  platformMocks.saveDeviceToken.mockReset()
  platformMocks.clearDeviceToken.mockReset()
  platformMocks.hasDeviceToken.mockReset()
  platformMocks.hasDeviceToken.mockReturnValue(false)
})

// Renders shell Settings with isolated TanStack state
function renderDesktopSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog libraries={[]} libraryId={null} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

// Returns a minimal response for the pairing client
function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

test('starts, polls, and stores a shell pairing token', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/pair/start') {
        expect(JSON.parse(String(init?.body))).toEqual({
          device_name: 'Cairndex Desktop for Mac',
        })
        return Promise.resolve(
          response(200, {
            pair_code: 'ABC234',
            poll_key: 'poll-key',
          }),
        )
      }
      if (url === '/api/v1/auth/pair/poll') {
        expect(JSON.parse(String(init?.body))).toEqual({ poll_key: 'poll-key' })
        return Promise.resolve(
          response(200, {
            status: 'approved',
            token: 'cdx_device-token',
            library_ids: ['lib-one'],
          }),
        )
      }
      throw new Error(`unexpected request: ${url}`)
    }),
  )
  platformMocks.saveDeviceToken.mockResolvedValue(undefined)
  renderDesktopSettings()

  expect(screen.queryByRole('button', { name: 'Pair device' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Pair this device' }))

  expect(await screen.findByLabelText('Pairing code')).toHaveTextContent('ABC234')
  expect(
    await screen.findByText(/This device is paired/, {}, { timeout: 2500 }),
  ).toBeInTheDocument()
  expect(platformMocks.saveDeviceToken).toHaveBeenCalledWith('cdx_device-token', ['lib-one'])

  fireEvent.click(screen.getByRole('button', { name: 'Forget pairing' }))
  expect(platformMocks.clearDeviceToken).toHaveBeenCalledOnce()
  expect(await screen.findByRole('button', { name: 'Pair this device' })).toBeInTheDocument()
})

test('keeps the valid paired state visible after re-pairing fails', async () => {
  platformMocks.hasDeviceToken.mockReturnValue(true)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('server unavailable')))
  renderDesktopSettings()

  expect(screen.getByText(/This device is paired/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Pair again' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('server unavailable')
  expect(screen.getByText(/This device is paired/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Forget pairing' })).toBeInTheDocument()
})
