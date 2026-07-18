import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import type { LibraryRead } from '../api/client'
import { SettingsDialog } from './SettingsDialog'

const platformMocks = vi.hoisted(() => ({
  saveDeviceToken: vi.fn(),
  clearDeviceToken: vi.fn(),
  hasDeviceToken: vi.fn(() => false),
  getLibraryMapping: vi.fn(),
  locateLibrary: vi.fn(),
  clearLibraryMapping: vi.fn(),
}))

vi.mock('../platform', () => ({
  getHostLabels: () => ({
    revealFile: 'Reveal in Finder',
    openFile: 'Open in Default App',
    locateLibrary: 'Locate on This Mac',
    deviceName: 'Cairndex Desktop for Mac',
  }),
  hostOperationErrorMessage: (error: unknown) =>
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : 'The desktop action could not be completed.',
  getHostPlatform: () => ({
    kind: 'desktop',
    getLibraryMapping: platformMocks.getLibraryMapping,
    locateLibrary: platformMocks.locateLibrary,
    clearLibraryMapping: platformMocks.clearLibraryMapping,
  }),
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
  platformMocks.getLibraryMapping.mockReset()
  platformMocks.locateLibrary.mockReset()
  platformMocks.clearLibraryMapping.mockReset()
})

// Renders shell Settings with isolated TanStack state
function renderDesktopSettings(libraries: LibraryRead[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog libraries={libraries} libraryId={null} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

const library: LibraryRead = {
  id: 'registry-id',
  library_uuid: 'portable-uuid',
  name: 'Media',
  root_path: '/server/media',
  status: 'available',
  schema_version: 1,
  created_at: '2026-07-18T00:00:00Z',
  updated_at: '2026-07-18T00:00:00Z',
  last_opened_at: null,
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

test('locates a desktop library through the manifest-validated platform command', async () => {
  platformMocks.getLibraryMapping.mockResolvedValue(null)
  platformMocks.locateLibrary.mockResolvedValue('/Volumes/Media')
  renderDesktopSettings([library])

  fireEvent.click(screen.getByRole('button', { name: 'Libraries' }))
  expect(await screen.findByText('Not located on this computer')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Locate on This Mac' }))

  expect(platformMocks.locateLibrary).toHaveBeenCalledWith('registry-id', 'portable-uuid')
  expect(await screen.findByText('/Volumes/Media')).toBeInTheDocument()
})

test('surfaces a rejected library identity without recording a mapping', async () => {
  platformMocks.getLibraryMapping.mockResolvedValue(null)
  platformMocks.locateLibrary.mockRejectedValue({
    code: 'library_mismatch',
    message: 'The selected folder belongs to a different Cairndex library.',
  })
  renderDesktopSettings([library])

  fireEvent.click(screen.getByRole('button', { name: 'Libraries' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Locate on This Mac' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The selected folder belongs to a different Cairndex library.',
  )
  expect(screen.getByText('Not located on this computer')).toBeInTheDocument()
})
