import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import type { LibraryRead } from '../api/client'
import { SettingsDialog } from './SettingsDialog'

const AVAILABLE: LibraryRead = {
  id: 'available',
  library_uuid: '01J00000000000000000000000',
  name: 'Available Library',
  root_path: '/libraries/available',
  status: 'available',
  schema_version: 1,
  created_at: '2026-07-13T00:00:00Z',
  updated_at: '2026-07-13T00:00:00Z',
  last_opened_at: null,
}

const UNAVAILABLE: LibraryRead = {
  ...AVAILABLE,
  id: 'unavailable',
  library_uuid: '01J00000000000000000000001',
  name: 'Unavailable Library',
  root_path: '/libraries/unavailable',
  status: 'unavailable',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Render Settings with isolated TanStack state. */
function renderSettings(libraries: LibraryRead[], libraryId: string | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SettingsDialog libraries={libraries} libraryId={libraryId} onClose={() => undefined} />
    </QueryClientProvider>,
  )
}

/** Return a minimal fetch response for the API client. */
function response(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as Response
}

test('does not seed or submit an unavailable active library', async () => {
  let approvalBody: unknown = null
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/devices') return Promise.resolve(response(200, []))
      if (url === '/api/v1/auth/pair/approve') {
        approvalBody = JSON.parse(String(init?.body))
        return Promise.resolve(response(204))
      }
      throw new Error(`unexpected request: ${url}`)
    }),
  )
  renderSettings([UNAVAILABLE, AVAILABLE], UNAVAILABLE.id)

  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }))
  const unavailable = screen.getByRole('checkbox', { name: /Unavailable Library/ })
  expect(unavailable).toBeDisabled()
  expect(unavailable).not.toBeChecked()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Available Library' }))
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'O0I1ABC234' } })
  expect(screen.getByLabelText('Pairing code')).toHaveValue('ABC234')
  fireEvent.click(screen.getByRole('button', { name: 'Approve device' }))

  await waitFor(() =>
    expect(approvalBody).toEqual({ pair_code: 'ABC234', library_ids: ['available'] }),
  )
})

test('filters a selected library that becomes unavailable before approval', async () => {
  let approvalBody: unknown = null
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/v1/auth/devices') return Promise.resolve(response(200, []))
      if (url === '/api/v1/auth/pair/approve') {
        approvalBody = JSON.parse(String(init?.body))
        return Promise.resolve(response(204))
      }
      throw new Error(`unexpected request: ${url}`)
    }),
  )
  const view = renderSettings([AVAILABLE], AVAILABLE.id)
  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }))
  expect(screen.getByRole('checkbox', { name: 'Available Library' })).toBeChecked()

  view.rerender(
    <QueryClientProvider client={new QueryClient()}>
      <SettingsDialog
        libraries={[{ ...AVAILABLE, status: 'unavailable' }, UNAVAILABLE]}
        libraryId={AVAILABLE.id}
        onClose={() => undefined}
      />
    </QueryClientProvider>,
  )
  expect(screen.getByRole('checkbox', { name: /Available Library/ })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Approve device' })).toBeDisabled()
  expect(approvalBody).toBeNull()
})

test('surfaces validation detail and resets pairing mutation state', async () => {
  let approvals = 0
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url === '/api/v1/auth/devices') return Promise.resolve(response(200, []))
      if (url === '/api/v1/auth/pair/approve') {
        approvals += 1
        return Promise.resolve(
          approvals === 1
            ? response(422, {
                detail: [{ loc: ['body', 'pair_code'], msg: 'Pairing code is invalid' }],
              })
            : response(204),
        )
      }
      throw new Error(`unexpected request: ${url}`)
    }),
  )
  renderSettings([AVAILABLE], AVAILABLE.id)

  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }))
  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'ABC234' } })
  fireEvent.click(screen.getByRole('button', { name: 'Approve device' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Pairing code is invalid')

  fireEvent.click(screen.getByRole('button', { name: 'Cancel pairing' }))
  fireEvent.click(screen.getByRole('button', { name: 'Pair device' }))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Pairing code')).toHaveValue('')

  fireEvent.change(screen.getByLabelText('Pairing code'), { target: { value: 'DEF567' } })
  fireEvent.click(screen.getByRole('button', { name: 'Approve device' }))
  expect(await screen.findByRole('status')).toHaveTextContent('Pairing approved')
  expect(screen.getByLabelText('Pairing code')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Approve device' })).toBeDisabled()
})
