import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { SettingsDialog } from './SettingsDialog'

const platformMocks = vi.hoisted(() => ({
  saveDeviceToken: vi.fn(),
}))

vi.mock('../platform', () => ({
  getHostLabels: () => ({
    revealFile: 'Reveal in Finder',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Mac',
    deviceName: 'Cairndex Desktop for Mac',
  }),
  getHostPlatform: () => ({ kind: 'desktop' }),
  hasHostDeviceToken: () => false,
  hostFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
  resolveHostAssetUrl: (value: string) => value,
  saveHostDeviceToken: platformMocks.saveDeviceToken,
}))

afterEach(() => {
  vi.unstubAllGlobals()
  platformMocks.saveDeviceToken.mockReset()
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
        return Promise.resolve(response(200, { status: 'approved', token: 'cdx_device-token' }))
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
  expect(platformMocks.saveDeviceToken).toHaveBeenCalledWith('cdx_device-token')
})
