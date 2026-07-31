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

function mockApi(
  libraries: unknown[] = [LIBRARY],
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
  } = {},
) {
  const storyboardStatus = options.storyboardStatus ?? 'succeeded'
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      let body: unknown = {}
      if (url.endsWith('/api/v1/libraries')) body = libraries
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
})

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
  expect(screen.getByText('Recent')).toBeInTheDocument()
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

test('a non-empty trash stays reachable when write mode is off', async () => {
  // LIBRARY has write_mode_enabled: false — but a deletion from an earlier
  // write-mode session is still recoverable, so the entry must not vanish.
  mockApi([LIBRARY], {
    trashOperations: [{ operation_id: 'op-1', deleted_at: '2026-07-23T10:00:00Z', entries: [] }],
  })
  renderApp()
  expect(await screen.findByRole('button', { name: 'Trash' })).toBeInTheDocument()
})

test('a library that never deleted anything shows no Trash entry', async () => {
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Nothing here yet.')).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Trash' })).not.toBeInTheDocument()
})

test('shows the empty shell (not a forced dialog) when no library exists', async () => {
  mockApi([])
  renderApp()
  // Empty shell with a hint, not the forced "Libraries" manager modal.
  await waitFor(() => expect(screen.getByText(/No library yet/i)).toBeInTheDocument())
  expect(screen.queryByRole('heading', { name: 'Libraries' })).not.toBeInTheDocument()
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
  expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/bundles/browse'))).toBe(
    true,
  )
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

const COLLECTION = {
  id: 'c1',
  name: 'Westerns',
  parent_id: null,
  sort_order: 0,
  note: null,
  cover_bundle_id: null,
  version: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

/** The sidebar tree row for a collection, found by its name (the tree sorts by
 *  manual order then name, so position is not a stable handle). */
function sidebarRow(container: HTMLElement, name: string): HTMLElement {
  const row = [...container.querySelectorAll('.collection-row[role="treeitem"]')].find((el) =>
    el.textContent?.includes(name),
  )
  expect(row).toBeDefined()
  return row as HTMLElement
}

test('a collection selected in the grid does not light up its sidebar row', async () => {
  // The sidebar highlight means "this is where you are". Selecting a folder card
  // in the grid does not navigate, so lighting the matching row said the app had
  // moved when it hadn't. The selection is shown on the surface that made it.
  mockApi([LIBRARY], { collections: [COLLECTION, { ...COLLECTION, id: 'c2', name: 'Noir' }] })
  const { container } = renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())

  const card = await waitFor(() => {
    const el = container.querySelector('[data-collection-id="c1"]')
    expect(el).not.toBeNull()
    return el as HTMLElement
  })
  fireEvent.click(card)

  expect(card.className).toContain('collcard--selected')
  expect(sidebarRow(container, 'Westerns').className).not.toContain('nav-item--active')
})

test('a collection selected in the sidebar does light up its row, and only there', async () => {
  mockApi([LIBRARY], { collections: [COLLECTION, { ...COLLECTION, id: 'c2', name: 'Noir' }] })
  const { container } = renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())
  await waitFor(() => expect(container.querySelector('[data-collection-id="c1"]')).not.toBeNull())

  const row = sidebarRow(container, 'Westerns')
  // Cmd-click builds the sidebar's own multi-selection without navigating.
  fireEvent.click(row, { metaKey: true })

  expect(sidebarRow(container, 'Westerns').className).toContain('nav-item--active')
  // …and the matching grid card stays unselected: one selection, shown once.
  const card = container.querySelector('[data-collection-id="c1"]') as HTMLElement
  expect(card.className).not.toContain('collcard--selected')
})

test('Recent offers the date orders and nothing else', async () => {
  // Recent is the All view ranked by a date; *which* date is the only choice it
  // has. Title or Size there would be the All view under another name, so the
  // menu is narrowed rather than the control being removed.
  mockApi()
  renderApp()
  await waitFor(() => expect(screen.getByText('Cairndex')).toBeInTheDocument())

  const sortButton = () => screen.getByRole('button', { name: 'Sort' })
  fireEvent.click(sortButton())
  expect(screen.getByText('File Count')).toBeInTheDocument()
  fireEvent.click(sortButton())

  fireEvent.click(screen.getByText('Recent'))

  // A sort carried in from another view (Manual) can't be expressed here, so it
  // falls back to Date Added rather than showing a label the menu cannot offer.
  expect(sortButton()).toHaveTextContent('Date Added')
  fireEvent.click(sortButton())
  // Scoped to the menu: "Date Added" is also the button's own label.
  const options = document.querySelectorAll('.sortctl__section:first-of-type .sortctl__opt')
  expect([...options].map((o) => o.textContent?.replace('✓', ''))).toEqual([
    'Date Added',
    'Date Modified',
    'Date Opened',
  ])
})
