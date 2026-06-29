import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import App from './App'

// jsdom has no layout, so the virtualized grid (which needs a measured width)
// renders nothing here — card/grid rendering is covered by the Playwright e2e.
// These tests verify the shell structure, data wiring, and the empty state.

const LIBRARY = {
  id: 'lib1',
  library_uuid: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
  name: 'Test Library',
  root_path: '/srv/library',
  status: 'available',
  schema_version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_opened_at: null,
}

function mockApi(libraries: unknown[] = [LIBRARY]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      let body: unknown = {}
      if (url.endsWith('/api/v1/libraries')) body = libraries
      else if (url.includes('/bundles/browse'))
        body = { items: [], total: 0, offset: 0, limit: 100 }
      else if (url.includes('/bundles/counts'))
        body = { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 }
      else if (url.includes('/collections/counts')) body = { counts: {} }
      else if (url.includes('/collections')) body = { items: [], next_cursor: null }
      else if (url.includes('/smart-collections')) body = []
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    }),
  )
}

afterEach(() => vi.restoreAllMocks())

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  )
}

test('renders the shell with the brand and the system views', async () => {
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())
  expect(screen.getByText('Recently Added')).toBeInTheDocument()
  expect(screen.getByText('Uncategorized')).toBeInTheDocument()
  expect(screen.getByText('Missing Files')).toBeInTheDocument()
})

test('shows the empty state when there are no bundles', async () => {
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Nothing here yet.')).toBeInTheDocument())
})

test('shows the empty shell (not a forced dialog) when no library exists', async () => {
  mockApi([])
  renderApp()
  // Empty shell with a hint, not the forced "Libraries" manager modal.
  await waitFor(() => expect(screen.getByText(/No library yet/i)).toBeInTheDocument())
  expect(screen.queryByRole('heading', { name: 'Libraries' })).not.toBeInTheDocument()
})
