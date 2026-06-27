import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import App from './App'

// jsdom has no layout, so the virtualized grid (which needs a measured width)
// renders nothing here — card/grid rendering is covered by the Playwright e2e.
// These tests verify the shell structure, data wiring, and the empty state.

function mockApi(overrides: Record<string, unknown> = {}) {
  const responses: Record<string, unknown> = {
    '/api/v1/bundles/counts': { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 },
    '/api/v1/collections/counts': { counts: {} },
    '/api/v1/collections': { items: [], next_cursor: null },
    '/api/v1/storage-roots': { items: [], next_cursor: null },
    browse: { items: [], total: 0, offset: 0, limit: 100 },
    ...overrides,
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const key = url.includes('/bundles/browse')
        ? 'browse'
        : (Object.keys(responses).find((k) => url.includes(k)) ?? '')
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(responses[key]) })
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

test('renders the shell with the brand and the system views', () => {
  mockApi()
  renderApp()
  expect(screen.getByText('Cairndex')).toBeInTheDocument()
  expect(screen.getByText('Recently Added')).toBeInTheDocument()
  expect(screen.getByText('Uncategorized')).toBeInTheDocument()
  expect(screen.getByText('Missing Files')).toBeInTheDocument()
})

test('shows the empty state when there are no bundles', async () => {
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Nothing here yet.')).toBeInTheDocument())
})
