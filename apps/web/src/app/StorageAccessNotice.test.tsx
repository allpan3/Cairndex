import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { LibraryConversionDialog } from './LibraryConversionDialog'
import { StorageAccessNotice } from './StorageAccessNotice'

afterEach(() => {
  vi.unstubAllGlobals()
})

test('Allow Access waits for the macOS request, then reports success', async () => {
  let answer = () => {}
  const authorize = vi.fn(() => new Promise<void>((resolve) => (answer = resolve)))
  const onAuthorized = vi.fn()
  render(
    <StorageAccessNotice
      access="authorization"
      authorize={authorize}
      onAuthorized={onAuthorized}
    />,
  )
  expect(screen.getByRole('alert')).toHaveTextContent('needs your permission')
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  expect(await screen.findByText(/Type it, then choose Always Allow/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Waiting for macOS…' })).toBeDisabled()
  answer()
  await waitFor(() => expect(onAuthorized).toHaveBeenCalledOnce())
  expect(screen.getByRole('button', { name: 'Allow Access…' })).toBeEnabled()
})

test('a refused request shows why and can be asked again', async () => {
  const authorize = vi
    .fn()
    .mockRejectedValueOnce(new Error('Synthetic refusal'))
    .mockResolvedValue(undefined)
  const onAuthorized = vi.fn()
  render(
    <StorageAccessNotice
      access="authorization"
      authorize={authorize}
      onAuthorized={onAuthorized}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  expect(await screen.findByText('Synthetic refusal')).toBeInTheDocument()
  expect(onAuthorized).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  await waitFor(() => expect(onAuthorized).toHaveBeenCalledOnce())
})

test('a missing saved login points to Finder and offers no request', () => {
  render(<StorageAccessNotice access="login" authorize={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('In Finder, connect to the share')
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

const ACTIVATION = 'a'.repeat(32)
const PREPARATION = 'b'.repeat(32)

test('a conversion stopped by share access is allowed, then retried', async () => {
  const requests: string[] = []
  const reply = (status: number, body?: unknown) =>
    Promise.resolve({ ok: status < 300, status, json: () => Promise.resolve(body) } as Response)
  const prepared = {
    id: PREPARATION,
    root_path: '/srv/Synthetic',
    action: 'prepare',
    attempt: PREPARATION,
    state: 'succeeded',
    result: { attempt: PREPARATION, receipt: 'c'.repeat(64), backup_name: '.cairndex-legacy-x' },
  }
  let activation: Record<string, unknown> = {
    id: ACTIVATION,
    root_path: '/srv/Synthetic',
    action: 'activate',
    attempt: PREPARATION,
    state: 'failed',
    error: 'Cairndex needs your permission to use the login saved for this network share.',
    error_code: 'storage_authorization',
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.endsWith(`/tasks/${PREPARATION}`)) return reply(200, prepared)
      if (url.endsWith(`/tasks/${ACTIVATION}/authorize-storage`)) return reply(204)
      if (url.endsWith(`/tasks/${ACTIVATION}/retry`)) {
        activation = { ...activation, state: 'queued', error: null, error_code: null }
        return reply(200, activation)
      }
      if (url.endsWith(`/tasks/${ACTIVATION}`)) return reply(200, activation)
      throw new Error(`unexpected request: ${url}`)
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <LibraryConversionDialog
        root={null}
        history={{ task: ACTIVATION, preparation: PREPARATION, activation: ACTIVATION }}
        remember={() => {}}
        onClose={() => {}}
        onOpen={() => {}}
      />
    </QueryClientProvider>,
  )
  expect(await screen.findByText(/needs your permission/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  await waitFor(() =>
    expect(requests).toContain(
      `POST /api/v1/libraries/conversions/tasks/${ACTIVATION}/authorize-storage`,
    ),
  )
  await waitFor(() =>
    expect(requests).toContain(`POST /api/v1/libraries/conversions/tasks/${ACTIVATION}/retry`),
  )
})
