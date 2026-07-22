import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LibraryRead, PathProbe, PathSuggestion } from '../api/client'
import { LibraryManager } from './LibraryManager'

// The browser half of the unified add flow: one path field, one action, and the
// server deciding what that path is. `Browse…` is desktop-only and lives in
// LibraryManager.desktop.test.tsx.

const openHostFolder = vi.fn()
const confirmHostPick = vi.fn()
vi.mock('../desktop/openLibraryFolder', () => ({
  openLibraryFolder: (uuids: string[]) => openHostFolder(uuids),
  confirmPickedLibrary: (token: string, name: string) => confirmHostPick(token, name),
}))

const MOVIES: LibraryRead = {
  id: 'lib-movies',
  library_uuid: '01J00000000000000000000000',
  name: 'Movies',
  root_path: '/srv/movies',
  status: 'available',
  schema_version: 1,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  last_opened_at: null,
}

const PLAIN_FOLDER: PathProbe = {
  exists: true,
  is_library: false,
  already_registered_id: null,
  manifest_display_name: null,
  folder_name: 'Holiday Videos',
}

interface Recorded {
  method: string
  url: string
  body: Record<string, unknown> | null
}

let requests: Recorded[]
let libraries: LibraryRead[]
let probe: PathProbe
let suggestions: PathSuggestion[]

// Routes the API surface this modal touches; every request is recorded so a test
// can assert what was *not* sent as easily as what was.
function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({
        method,
        url,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
      })
      const reply = (status: number, body?: unknown) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        } as Response)

      if (url.startsWith('/api/v1/libraries/path-suggestions')) return reply(200, { suggestions })
      if (url.startsWith('/api/v1/libraries/probe-path')) return reply(200, probe)
      if (url === '/api/v1/libraries/register')
        return reply(201, { ...MOVIES, id: 'lib-registered', name: 'Registered' })
      if (url === '/api/v1/libraries/create')
        return reply(201, { ...MOVIES, id: 'lib-created', name: 'Created' })
      if (url === '/api/v1/libraries') return reply(200, libraries)
      if (method === 'DELETE') return reply(204)
      throw new Error(`unexpected request: ${method} ${url}`)
    }),
  )
}

beforeEach(() => {
  requests = []
  libraries = [MOVIES]
  probe = PLAIN_FOLDER
  suggestions = []
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderManager(
  handlers: {
    onClose?: () => void
    onSelect?: (id: string) => void
    onRemoved?: (id: string) => void
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <LibraryManager
        onClose={handlers.onClose ?? (() => undefined)}
        onSelect={handlers.onSelect}
        onRemoved={handlers.onRemoved}
      />
    </QueryClientProvider>,
  )
}

function typePath(value: string) {
  fireEvent.change(screen.getByLabelText('Library path'), { target: { value } })
}

const sent = (method: string, url: string) =>
  requests.find((request) => request.method === method && request.url.startsWith(url))

// --- one action, three outcomes ---------------------------------------------

test('registers an existing library without being told it is one', async () => {
  probe = {
    exists: true,
    is_library: true,
    already_registered_id: null,
    manifest_display_name: 'Family Photos',
    folder_name: 'Images',
  }
  const onSelect = vi.fn()
  const onClose = vi.fn()
  renderManager({ onSelect, onClose })

  typePath('/srv/photos')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/register')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/register')?.body).toEqual({ root_path: '/srv/photos' })
  // No name was asked for: an existing library keeps the name it travels with.
  expect(screen.queryByLabelText('Library name')).toBeNull()
  expect(sent('POST', '/api/v1/libraries/create')).toBeUndefined()
  await waitFor(() => expect(onSelect).toHaveBeenCalledWith('lib-registered'))
  expect(onClose).toHaveBeenCalled()
})

test('selects a folder this server already has instead of adding it twice', async () => {
  probe = {
    exists: true,
    is_library: true,
    already_registered_id: MOVIES.id,
    manifest_display_name: 'Movies',
    folder_name: 'movies',
  }
  const onSelect = vi.fn()
  renderManager({ onSelect })

  typePath('/srv/movies')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(MOVIES.id))
  expect(sent('POST', '/api/v1/libraries/register')).toBeUndefined()
  expect(sent('POST', '/api/v1/libraries/create')).toBeUndefined()
})

test('offers a plain folder as a new library named after the folder', async () => {
  renderManager()

  typePath('/srv/Holiday Videos')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  const name = await screen.findByLabelText('Library name')
  // Prefilled, so confirming is one click and renaming is right there.
  expect(name).toHaveValue('Holiday Videos')
  expect(screen.getByText(/isn’t a Cairndex library/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/create')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/create')?.body).toEqual({
    root_path: '/srv/Holiday Videos',
    display_name: 'Holiday Videos',
    create_if_missing: false,
  })
})

test('creates the folder too when the typed path does not exist yet', async () => {
  probe = { ...PLAIN_FOLDER, exists: false, folder_name: 'New Library' }
  renderManager()

  typePath('/srv/New Library')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  // The confirmation says so, in place of the old create-if-missing checkbox.
  expect(await screen.findByText(/doesn’t exist yet/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Create library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/create')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/create')?.body).toMatchObject({
    create_if_missing: true,
  })
})

test('the name typed in the confirmation is the name created', async () => {
  renderManager()

  typePath('/srv/Holiday Videos')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
  fireEvent.change(await screen.findByLabelText('Library name'), {
    target: { value: '  Trips  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/create')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/create')?.body).toMatchObject({ display_name: 'Trips' })
})

test('cancelling the confirmation creates nothing and keeps the typed path', async () => {
  renderManager()

  typePath('/srv/Holiday Videos')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(sent('POST', '/api/v1/libraries/create')).toBeUndefined()
  expect(screen.getByLabelText('Library path')).toHaveValue('/srv/Holiday Videos')
})

test('reports the server’s reason when a path cannot be added', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const reply = (status: number, body?: unknown) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        } as Response)
      if (url.startsWith('/api/v1/libraries/path-suggestions'))
        return reply(200, { suggestions: [] })
      if (url.startsWith('/api/v1/libraries/probe-path'))
        return reply(422, { message: 'manifest is not valid JSON' })
      return reply(200, [])
    }),
  )
  renderManager()

  typePath('/srv/broken')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  expect(await screen.findByText(/manifest is not valid JSON/)).toBeInTheDocument()
})

// --- removal (metadata-only) -------------------------------------------------

test('removes a library after an in-modal confirmation that says files are safe', async () => {
  const onRemoved = vi.fn()
  renderManager({ onRemoved })
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies' }))

  // The confirmation is the place to say what removal does *not* do.
  expect(screen.getByText(/folder and its files are not touched/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove' }))

  await waitFor(() => expect(sent('DELETE', `/api/v1/libraries/${MOVIES.id}`)).toBeTruthy())
  await waitFor(() => expect(onRemoved).toHaveBeenCalledWith(MOVIES.id))
})

test('cancelling removal deletes nothing', async () => {
  const onRemoved = vi.fn()
  renderManager({ onRemoved })
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Remove Movies' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  expect(requests.some((request) => request.method === 'DELETE')).toBe(false)
  expect(onRemoved).not.toHaveBeenCalled()
  expect(screen.getByText('/srv/movies')).toBeInTheDocument()
})

// --- autocomplete ------------------------------------------------------------

test('arrow keys and Enter walk into a suggested directory', async () => {
  suggestions = [
    { path: '/mnt/media', is_library: false },
    { path: '/mnt/music', is_library: false },
  ]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt' } })
  await screen.findByRole('option', { name: /\/mnt\/media/ })

  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  // The active option is announced, not merely highlighted.
  expect(input).toHaveAttribute('aria-activedescendant', 'path-option-1')

  fireEvent.keyDown(input, { key: 'Enter' })

  // A trailing separator, so the next request lists this directory's children —
  // one keystroke per level rather than one selection and a dead end.
  expect(input).toHaveValue('/mnt/music/')
  expect(screen.getByRole('listbox')).toBeInTheDocument()
})

test('ArrowUp from the top wraps to the last suggestion', async () => {
  suggestions = [
    { path: '/mnt/media', is_library: false },
    { path: '/mnt/music', is_library: false },
  ]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt' } })
  await screen.findByRole('option', { name: /\/mnt\/media/ })

  fireEvent.keyDown(input, { key: 'ArrowUp' })

  expect(input).toHaveAttribute('aria-activedescendant', 'path-option-1')
})

test('Enter with no active option submits the path instead of the menu', async () => {
  suggestions = [{ path: '/mnt/media', is_library: false }]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt/media' } })
  await screen.findByRole('option', { name: /\/mnt\/media/ })
  fireEvent.keyDown(input, { key: 'Enter' })

  await waitFor(() => expect(sent('GET', '/api/v1/libraries/probe-path')).toBeTruthy())
})

test('Tab completes as far as the suggestions agree', async () => {
  suggestions = [
    { path: '/mnt/media-photos', is_library: false },
    { path: '/mnt/media-videos', is_library: false },
  ]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt/me' } })
  await screen.findByRole('option', { name: /media-photos/ })

  fireEvent.keyDown(input, { key: 'Tab' })

  expect(input).toHaveValue('/mnt/media-')
})

test('clicking elsewhere in the dialog dismisses the menu', async () => {
  // The dialog stops mousedown propagating, so that a click inside it never
  // reaches the backdrop and closes the whole modal. A dismissal that listened
  // on the bubble phase therefore never fired for the clicks a user actually
  // makes to get rid of the menu — every one of them is inside the dialog.
  suggestions = [{ path: '/mnt/media', is_library: false }]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt' } })
  await screen.findByRole('option', { name: /\/mnt\/media/ })

  fireEvent.mouseDown(screen.getByRole('heading', { name: 'Libraries' }))

  expect(screen.queryByRole('listbox')).toBeNull()
  // Dismissing is not editing: the typed path survives.
  expect(input).toHaveValue('/mnt')
})

test('clicking inside the menu keeps it open', async () => {
  suggestions = [
    { path: '/mnt/media', is_library: false },
    { path: '/mnt/music', is_library: false },
  ]
  renderManager()

  fireEvent.change(screen.getByLabelText('Library path'), { target: { value: '/mnt' } })
  const option = await screen.findByRole('option', { name: /\/mnt\/media/ })

  fireEvent.mouseDown(option)

  expect(screen.getByRole('listbox')).toBeInTheDocument()
})

test('Escape closes the menu without changing the path', async () => {
  suggestions = [{ path: '/mnt/media', is_library: false }]
  renderManager()
  const input = screen.getByLabelText('Library path')

  fireEvent.change(input, { target: { value: '/mnt' } })
  await screen.findByRole('option', { name: /\/mnt\/media/ })

  fireEvent.keyDown(input, { key: 'Escape' })

  expect(screen.queryByRole('listbox')).toBeNull()
  expect(input).toHaveValue('/mnt')
})

test('marks suggested directories that already are libraries', async () => {
  suggestions = [
    { path: '/mnt/media', is_library: false },
    { path: '/mnt/photos', is_library: true },
  ]
  renderManager()

  fireEvent.change(screen.getByLabelText('Library path'), { target: { value: '/mnt' } })

  const marked = await screen.findByRole('option', { name: /\/mnt\/photos/ })
  expect(marked).toHaveTextContent('library')
  expect(await screen.findByRole('option', { name: /\/mnt\/media/ })).not.toHaveTextContent(
    'library',
  )
})

test('the browser has no Browse… button, because it cannot produce a server path', () => {
  renderManager()

  expect(screen.queryByRole('button', { name: 'Browse…' })).toBeNull()
})
