import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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

function mockApi(
  libraries: unknown[] = [LIBRARY],
  options: { storyboardStatus?: 'succeeded' | 'failed' } = {},
) {
  const storyboardStatus = options.storyboardStatus ?? 'succeeded'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = {}
      if (url.endsWith('/api/v1/libraries')) body = libraries
      else if (url.includes('/bundles/browse'))
        body = { items: [], total: 0, offset: 0, limit: 100 }
      else if (url.includes('/bundles/counts'))
        body = { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 }
      else if (url.includes('/collections/counts')) body = { counts: {} }
      else if (url.includes('/collections')) body = { items: [], next_cursor: null }
      else if (url.includes('/smart-collections')) body = []
      else if (url.includes('/grouping/plans/plan1'))
        body = {
          id: 'plan1',
          status: 'open',
          rule_version: 2,
          scan_job_id: 'job1',
          generated_at: '2026-01-01T00:00:00Z',
          applied_at: null,
          proposals: [],
        }
      else if (url.includes('/grouping/plans'))
        body = [
          {
            id: 'plan1',
            status: 'open',
            rule_version: 2,
            generated_at: '2026-01-01T00:00:00Z',
            applied_at: null,
            proposal_count: 1,
          },
        ]
      else if (url.endsWith('/api/v1/jobs/job1'))
        body = {
          id: 'job1',
          library_id: 'lib1',
          job_type: 'scan',
          status: 'succeeded',
          payload: {},
          processed: 2,
          total: 2,
          result: { grouping_plan_id: 'plan1', grouping_proposal_count: 1 },
          error: null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:00Z',
          started_at: '2026-01-01T00:00:00Z',
          finished_at: '2026-01-01T00:00:01Z',
        }
      else if (url.endsWith('/api/v1/jobs/job2'))
        body = {
          id: 'job2',
          library_id: 'lib1',
          job_type: 'probe',
          status: 'succeeded',
          payload: {},
          processed: 2,
          total: 2,
          result: { probed: 0, skipped: 0, failed: 0 },
          error: null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:01Z',
          started_at: '2026-01-01T00:00:01Z',
          finished_at: '2026-01-01T00:00:02Z',
        }
      else if (url.endsWith('/api/v1/jobs/job3'))
        body = {
          id: 'job3',
          library_id: 'lib1',
          job_type: 'storyboard',
          status: storyboardStatus,
          payload: {},
          processed: 2,
          total: 2,
          result: storyboardStatus === 'succeeded' ? { generated: 0, skipped: 0, failed: 0 } : null,
          error: storyboardStatus === 'failed' ? 'Storyboard failed' : null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:02Z',
          started_at: '2026-01-01T00:00:02Z',
          finished_at: '2026-01-01T00:00:03Z',
        }
      else if (url.endsWith('/jobs/scan') && init?.method === 'POST')
        body = {
          id: 'job1',
          library_id: 'lib1',
          job_type: 'scan',
          status: 'queued',
          payload: {},
          processed: 0,
          total: null,
          result: null,
          error: null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:00Z',
          started_at: null,
          finished_at: null,
        }
      else if (url.endsWith('/jobs/probe') && init?.method === 'POST')
        body = {
          id: 'job2',
          library_id: 'lib1',
          job_type: 'probe',
          status: 'queued',
          payload: {},
          processed: 0,
          total: null,
          result: null,
          error: null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:01Z',
          started_at: null,
          finished_at: null,
        }
      else if (url.endsWith('/jobs/storyboards') && init?.method === 'POST')
        body = {
          id: 'job3',
          library_id: 'lib1',
          job_type: 'storyboard',
          status: 'queued',
          payload: {},
          processed: 0,
          total: null,
          result: null,
          error: null,
          cancel_requested: false,
          created_at: '2026-01-01T00:00:02Z',
          started_at: null,
          finished_at: null,
        }
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
  expect(screen.queryByText(/Thumbnails/i)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Update/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Scan/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Probe/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /Group/i })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'More library maintenance actions' }))
  expect(screen.getByRole('button', { name: /Scan new files/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Collect metadata/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Suggest grouping/i })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Generate storyboards/i })).toBeInTheDocument()
})

test('can generate storyboards independently from Update', async () => {
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())

  fireEvent.click(screen.getByRole('button', { name: 'More library maintenance actions' }))
  fireEvent.click(screen.getByRole('button', { name: 'Generate storyboards' }))

  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/\/jobs\/storyboards$/),
      expect.objectContaining({ method: 'POST' }),
    ),
  )
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

test('opens grouping review after a successful library update with suggestions', async () => {
  mockApi()
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: /Update/i }))
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Suggest grouping' })), {
    timeout: 2500,
  })
})

test('does not fail update when the background storyboard job fails', async () => {
  mockApi([LIBRARY], { storyboardStatus: 'failed' })
  renderApp()
  fireEvent.click(await screen.findByRole('button', { name: /Update/i }))

  await waitFor(() => expect(screen.getByRole('heading', { name: 'Suggest grouping' })), {
    timeout: 2500,
  })
  await waitFor(() => expect(screen.getByText('Storyboards failed')).toBeInTheDocument(), {
    timeout: 2500,
  })
  expect(screen.queryByText(/Background job failed/i)).not.toBeInTheDocument()
})
