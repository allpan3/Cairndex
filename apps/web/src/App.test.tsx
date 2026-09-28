import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import App from './App'
import * as platform from './platform'

const desktopMenu = vi.hoisted(() => ({
  handler: null as ((action: string) => void) | null,
}))

const openFolder = vi.hoisted(() => ({ run: vi.fn(), confirm: vi.fn() }))
vi.mock('./desktop/openLibraryFolder', () => ({
  openLibraryFolder: () => openFolder.run(),
  confirmPickedLibrary: (token: string, name: string) => openFolder.confirm(token, name),
}))

vi.mock('./desktop/useDesktopMenu', () => ({
  useDesktopMenu: (handler: (action: string) => void) => {
    desktopMenu.handler ??= handler
  },
  useDesktopMenuAvailability: vi.fn(),
}))

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
  write_mode_enabled: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  last_opened_at: null,
}

const UNAVAILABLE_LIBRARY = {
  ...LIBRARY,
  id: 'lib-offline',
  library_uuid: '01J00000000000000000000000',
  name: 'Offline Test Library',
  root_path: '/fixtures/offline-library',
  status: 'unavailable',
}

type LibrarySource = unknown[] | (() => unknown[] | Promise<unknown[]>)

/** Installs deterministic storage for tests that exercise remembered shell state. */
function mockLocalStorage(initial: Record<string, string>) {
  const values = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  })
  return values
}

function mockApi(
  libraries: LibrarySource = [LIBRARY],
  options: {
    storyboardStatus?: 'succeeded' | 'failed'
    locked?: boolean
    authError?: number
    /** Deletions in the library's trash — recoverable even with write mode off. */
    trashOperations?: unknown[]
    /** Collections in the library (sidebar tree + folder cards). */
    collections?: unknown[]
    /** Deferred mount decision for cold-start ownership ordering coverage. */
    ownership?: Promise<unknown>
    /** Deferred probe enqueue for scan-to-grouping ordering coverage */
    probeEnqueue?: Promise<unknown>
  } = {},
) {
  const storyboardStatus = options.storyboardStatus ?? 'succeeded'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = {}
      if (url.endsWith('/api/v1/libraries'))
        body = typeof libraries === 'function' ? libraries() : libraries
      else if (url.includes('/file-ops/trash'))
        body = { operations: options.trashOperations ?? [], size_bytes: 0 }
      else if (url.endsWith('/auth/status') && options.authError)
        return Promise.resolve({
          ok: false,
          status: options.authError,
          json: () => Promise.resolve({ message: 'Device token is not authorized' }),
        })
      else if (url.endsWith('/auth/status'))
        body = { protected: Boolean(options.locked), unlocked: !options.locked }
      else if (url.endsWith('/ownership') && options.ownership)
        return options.ownership.then((ownership) => ({
          ok: true,
          status: 200,
          json: () => Promise.resolve(ownership),
        }))
      else if (url.endsWith('/api/v1/auth/devices')) body = []
      else if (url.includes('/bundles/browse'))
        body = { items: [], total: 0, offset: 0, limit: 100 }
      else if (url.includes('/bundles/counts'))
        body = { all: 0, recent: 0, uncategorized: 0, untagged: 0, missing: 0 }
      else if (url.includes('/collections/counts')) body = { counts: {} }
      else if (url.includes('/collections'))
        body = { items: options.collections ?? [], next_cursor: null }
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
      // The query string carries suggest_grouping, so match the path, not the end.
      else if (url.includes('/jobs/scan') && init?.method === 'POST')
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
      else if (url.endsWith('/jobs/probe') && init?.method === 'POST' && options.probeEnqueue)
        return options.probeEnqueue.then((probe) => ({
          ok: true,
          status: 202,
          json: () => Promise.resolve(probe),
        }))
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

// Presents the shared App through the desktop capability surface
function mockDesktopPlatform({ paired = true, access = false } = {}) {
  vi.spyOn(platform, 'getHostPlatform').mockReturnValue({
    ...platform.getHostPlatform(),
    kind: 'desktop',
  })
  vi.spyOn(platform, 'hasHostDeviceToken').mockReturnValue(paired)
  vi.spyOn(platform, 'hasHostDeviceAccess').mockReturnValue(access)
}

afterEach(() => {
  desktopMenu.handler = null
  openFolder.run.mockReset()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  )
}

test('shows the empty shell (not a forced dialog) when no library exists', async () => {
  mockApi([])
  renderApp()
  // Empty shell with a hint, not the forced "Libraries" manager modal.
  await waitFor(() => expect(screen.getByText(/No library yet/i)).toBeInTheDocument())
  expect(screen.queryByRole('heading', { name: 'Libraries' })).not.toBeInTheDocument()
})

test('preserves an unavailable remembered library until the user chooses a sibling', async () => {
  const available = { ...LIBRARY, id: 'lib-available', name: 'Available Test Library' }
  const storage = mockLocalStorage({ 'cairndex.libraryId': JSON.stringify(UNAVAILABLE_LIBRARY.id) })
  mockApi([UNAVAILABLE_LIBRARY, available])
  renderApp()
  expect(await screen.findByText('Library unavailable')).toBeInTheDocument()
  expect(storage.get('cairndex.libraryId')).toBe(JSON.stringify(UNAVAILABLE_LIBRARY.id))
  const requestedUrls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
  expect(requestedUrls.some((url) => url.includes(`/${available.id}/auth/status`))).toBe(false)
  fireEvent.change(screen.getByRole('combobox', { name: 'Library' }), {
    target: { value: available.id },
  })
  expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument()
  await waitFor(() => expect(storage.get('cairndex.libraryId')).toBe(JSON.stringify(available.id)))
})

test('shows recovery actions without querying an unavailable library', async () => {
  mockApi([UNAVAILABLE_LIBRARY])
  renderApp()

  expect(await screen.findByText('Library unavailable')).toBeInTheDocument()
  expect(screen.getByText(/Reconnect its drive or network share/)).toBeInTheDocument()
  expect(screen.queryByText(UNAVAILABLE_LIBRARY.id)).not.toBeInTheDocument()
  expect(screen.queryByText(UNAVAILABLE_LIBRARY.root_path)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled()

  const requestedUrls = vi.mocked(fetch).mock.calls.map(([url]) => String(url))
  expect(requestedUrls.some((url) => url.includes(`/${UNAVAILABLE_LIBRARY.id}/`))).toBe(false)
  expect(requestedUrls.some((url) => url.includes('/bundles/browse'))).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Manage Libraries' }))
  expect(await screen.findByRole('heading', { name: 'Libraries' })).toBeInTheDocument()
})

test('retry recovers an unavailable library without navigation', async () => {
  let resolveRefresh: (libraries: unknown[]) => void = () => undefined
  let requestCount = 0
  const available = { ...UNAVAILABLE_LIBRARY, status: 'available' }
  mockApi(() => {
    requestCount += 1
    if (requestCount === 1) return [UNAVAILABLE_LIBRARY]
    return new Promise<unknown[]>((resolve) => {
      resolveRefresh = resolve
    })
  })
  renderApp()

  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  expect(await screen.findByRole('button', { name: 'Checking…' })).toBeDisabled()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/bundles/browse'))).toBe(
    false,
  )

  act(() => resolveRefresh([available]))

  expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument()
  expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
})

test('opens native settings over a locked library', async () => {
  mockApi([LIBRARY], { locked: true })
  renderApp()

  await screen.findByText(/Test Library is locked/)
  act(() => desktopMenu.handler?.('settings'))

  expect(await screen.findByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Devices' })).toBeInTheDocument()
  expect(screen.getByText(/Test Library is locked/)).toBeInTheDocument()
})

test('offers pairing instead of a dead passphrase form for protected desktop libraries', async () => {
  mockDesktopPlatform({ paired: true, access: false })
  mockApi([LIBRARY], { locked: true })
  renderApp()

  expect(await screen.findByText(/Test Library needs device access/)).toBeInTheDocument()
  expect(screen.queryByLabelText('Owner passphrase')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Pair again' })).toBeInTheDocument()
})

test('keeps an unscoped unprotected library available anonymously on desktop', async () => {
  mockDesktopPlatform({ paired: true, access: false })
  mockApi()
  renderApp()

  expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument()
  expect(screen.queryByText(/needs device access/)).not.toBeInTheDocument()
})

test('fails closed when library authorization cannot be verified', async () => {
  mockDesktopPlatform({ paired: true, access: true })
  mockApi([LIBRARY], { authError: 403 })
  renderApp()

  expect(await screen.findByText('Could not verify library access')).toBeInTheDocument()
  expect(screen.getByText(/credential may be invalid or revoked/)).toBeInTheDocument()
  expect(screen.queryByText('Nothing here yet.')).not.toBeInTheDocument()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/bundles/browse'))).toBe(
    false,
  )
})

test('waits for library ownership before starting content queries', async () => {
  let resolveOwnership: (ownership: unknown) => void = () => undefined
  const ownership = new Promise<unknown>((resolve) => {
    resolveOwnership = resolve
  })
  mockApi([LIBRARY], { ownership })
  renderApp()

  expect(await screen.findByText('Checking library ownership…')).toBeInTheDocument()
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/bundles/browse'))).toBe(
    false,
  )

  resolveOwnership({ mountable: true, state: 'own' })

  expect(await screen.findByText('Nothing here yet.')).toBeInTheDocument()
  expect(screen.getByText('Nothing here yet.')).toBeInTheDocument()
})

test('the Manage Libraries menu item works in the running app, not just at setup', async () => {
  // Regression: this was handled only in DesktopBootstrap, whose menu listener
  // tears down once the workspace mounts (`if (ready) return`). The item stayed
  // enabled and did nothing in the state a user actually spends their time in.
  // The unit tests missed it because they exercised the flow directly and never
  // the wiring that reaches it.
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())

  act(() => {
    desktopMenu.handler?.('manage-libraries')
  })

  // The dialog is the whole surface now: adding, opening, and removing.
  expect(await screen.findByRole('heading', { name: 'Libraries' })).toBeInTheDocument()
  expect(screen.getByLabelText('Library path')).toBeInTheDocument()
  // Opening it must not reach the shell on its own — Browse… does that.
  expect(openFolder.run).not.toHaveBeenCalled()
})

test('surfaces authorization loss after a successful session', async () => {
  mockApi()
  const original = vi.mocked(fetch).getMockImplementation()!
  let revoked = false
  vi.mocked(fetch).mockImplementation((input, init) =>
    revoked && String(input).endsWith('/auth/status')
      ? Promise.resolve(
          new Response(JSON.stringify({ message: 'Session expired' }), { status: 401 }),
        )
      : original(input, init),
  )
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  )
  await screen.findByText('Nothing here yet.')
  revoked = true
  await act(async () => {
    await qc.invalidateQueries({ queryKey: ['auth-status'] })
  })
  expect(await screen.findByText('Could not verify library access')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Servers…' })).toBeEnabled()
})

// These tests cover admission and connection routing; catalog UI has its own tests.
vi.mock('./app/ReplicaWorkspace', () => ({
  ReplicaWorkspace: ({ onManage }: { onManage: () => void }) => (
    <div>
      <span>Cairndex</span>
      <span>Nothing here yet.</span>
      <button onClick={onManage}>Manage libraries</button>
    </div>
  ),
}))
