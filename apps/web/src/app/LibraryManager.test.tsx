import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
  schema_version: 3,
  package_format: 'cairndex.replica-library',
  write_mode_enabled: false,
  created_at: '2026-07-22T00:00:00Z',
  updated_at: '2026-07-22T00:00:00Z',
  last_opened_at: null,
}

const TRIPS: LibraryRead = {
  ...MOVIES,
  id: 'lib-trips',
  library_uuid: '01J11111111111111111111111',
  name: 'Trips',
  root_path: '/srv/trips',
}

const PLAIN_FOLDER: PathProbe = {
  exists: true,
  is_library: false,
  needs_conversion: false,
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
// The deployment master switch (ADR-0013 §1), as `/health` reports it.
let deploymentWriteMode: 'allowed' | 'disabled'
// The passphrase the stubbed server will accept, or null for an unlocked
// library that needs none. Anything else gets the same generic 401.
let requiredPassphrase: string | null
// A locked library authorizes a write-mode change only by its passphrase.
let locked: boolean
// Failures the next write-mode changes meet before the server accepts one.
let writeFailures: number
let ownershipState: 'own' | 'locally_released'

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
      if (url === '/api/v1/health')
        return reply(200, {
          status: 'ok',
          app_name: 'Cairndex',
          environment: 'test',
          api_features: ['pairing', 'progress'],
          write_mode: deploymentWriteMode,
        })
      if (url.endsWith('/write-mode') && method === 'PUT') {
        const body = (init?.body ? JSON.parse(String(init.body)) : {}) as {
          enabled?: boolean
          passphrase?: string | null
        }
        const verified = requiredPassphrase !== null && body.passphrase === requiredPassphrase
        if ((locked || (body.enabled && requiredPassphrase !== null)) && !verified) {
          return reply(401, { code: 'auth_required', message: 'Passphrase required.' })
        }
        if (writeFailures > 0) {
          writeFailures -= 1
          return reply(503, { message: 'Synthetic registry failure' })
        }
        // The registry now holds the new flag, so the listing this modal
        // refetches must agree — otherwise the test would only ever prove the
        // optimistic patch, and a server that ignored the write would pass.
        libraries = libraries.map((library) =>
          url.includes(library.id)
            ? { ...library, write_mode_enabled: body.enabled ?? false }
            : library,
        )
        return reply(200, {
          enabled: body.enabled ?? false,
          allowed_by_deployment: deploymentWriteMode === 'allowed',
          effective: (body.enabled ?? false) && deploymentWriteMode === 'allowed',
          requires_passphrase: requiredPassphrase !== null,
        })
      }
      if (url.endsWith('/ownership'))
        return reply(200, { state: ownershipState, mountable: ownershipState === 'own' })
      if (url.endsWith('/auth/status'))
        return reply(200, {
          protected: requiredPassphrase !== null,
          unlocked: !locked,
          access_settings_version: 1,
          private_recovery_version: 1,
        })
      if (url.includes('/private-recovery/tasks'))
        return reply(200, { items: [], next_cursor: null })
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
  deploymentWriteMode = 'allowed'
  requiredPassphrase = null
  locked = false
  writeFailures = 0
  ownershipState = 'own'
  vi.clearAllMocks()
  stubApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// jsdom has no layout, and an InfoTip shows its text only beside a button
// that is on screen, so give the button the box a browser would
function onScreen(element: HTMLElement) {
  const box = { left: 100, top: 100, right: 116, bottom: 116, width: 16, height: 16 }
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box as DOMRect)
}

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
    needs_conversion: false,
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
    needs_conversion: false,
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

  fireEvent.click(screen.getByRole('button', { name: 'Create library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/create')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/create')?.body).toEqual({
    root_path: '/srv/Holiday Videos',
    display_name: 'Holiday Videos',
    create_if_missing: false,
  })
})

test('reviews an already registered old library instead of opening or registering it', async () => {
  libraries = [{ ...MOVIES, package_format: 'cairndex.library', status: 'unavailable' }]
  probe = {
    ...PLAIN_FOLDER,
    is_library: true,
    needs_conversion: true,
    already_registered_id: MOVIES.id,
  }
  const onSelect = vi.fn()
  renderManager({ onSelect })
  await screen.findByRole('button', { name: 'Convert Movies' })
  expect(screen.queryByRole('button', { name: 'Open Movies' })).not.toBeInTheDocument()
  typePath('/srv/movies')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
  await screen.findByRole('dialog', { name: 'Convert old library' })
  expect(onSelect).not.toHaveBeenCalled()
  expect(sent('POST', '/api/v1/libraries/register')).toBeUndefined()
  expect(sent('POST', '/api/v1/libraries/create')).toBeUndefined()
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
  fireEvent.click(screen.getByRole('button', { name: 'Create library' }))

  await waitFor(() => expect(sent('POST', '/api/v1/libraries/create')).toBeTruthy())
  expect(sent('POST', '/api/v1/libraries/create')?.body).toMatchObject({ display_name: 'Trips' })
})

test('the name step reuses the add row instead of inserting one above it', async () => {
  // Owner-reported: the confirmation used to appear *above* the form and push
  // the button somewhere else, so confirming meant hunting for it again. The
  // step now swaps the row's contents — same label line, same row, same
  // trailing sentence — so the button stays under the pointer that summoned it.
  renderManager()
  const form = screen.getByLabelText('Library path').closest('form') as HTMLFormElement
  const shapeBefore = [...form.children].map((child) => child.tagName)

  typePath('/srv/Holiday Videos')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
  await screen.findByLabelText('Library name')

  expect([...form.children].map((child) => child.tagName)).toEqual(shapeBefore)
  // The primary action is still the last control in the same row.
  const row = screen.getByLabelText('Library name').parentElement as HTMLElement
  expect(row.lastElementChild).toHaveTextContent('Create library')
  // And the explanation is below the row, not above it.
  const ask = screen.getByText(/isn’t a Cairndex library/)
  expect(row.compareDocumentPosition(ask) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

test('the add hint is short, with the explanation in a tooltip the keyboard reaches', () => {
  const onClose = vi.fn()
  renderManager({ onClose })
  const tip = screen.getByRole('button', { name: 'About adding a library' })
  const text = screen.getByRole('tooltip', { hidden: true })
  expect(tip).toHaveAttribute('aria-describedby', text.id)
  expect(text).toHaveTextContent(/existing library is added under its own name/)
  expect(text).not.toBeVisible()

  onScreen(tip)
  fireEvent.focus(tip)
  expect(screen.getByRole('tooltip')).toBeVisible()

  // Escape hides the tip and leaves the dialog open
  fireEvent.keyDown(tip, { key: 'Escape' })
  expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible()
  expect(onClose).not.toHaveBeenCalled()
})

// --- write mode (ADR-0013 §1, ADR-0036) --------------------------------------

const writeModeButton = () => screen.getByRole('button', { name: 'Write mode for Movies' })
const writeModeChanges = () =>
  requests.filter((request) => request.method === 'PUT' && request.url.endsWith('/write-mode'))

test('turning write mode on says what it allows before it does it', async () => {
  renderManager()
  await waitFor(() => expect(writeModeButton()).toBeEnabled())
  expect(writeModeButton()).toHaveAttribute('aria-pressed', 'false')
  expect(writeModeButton()).toHaveTextContent('Write mode: off')

  fireEvent.click(writeModeButton())

  // Nothing is sent yet: the step says what write mode allows first, and the
  // safe choice has focus.
  expect(writeModeChanges()).toHaveLength(0)
  expect(screen.getByText(/reviewed copy, rename, move and trash/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus()

  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))
  expect(writeModeButton()).toHaveTextContent('Write mode: on')
  expect(writeModeChanges().map((request) => request.body)).toEqual([
    { enabled: true, passphrase: null },
  ])
  // Focus goes back to the switch the step replaced
  await waitFor(() => expect(writeModeButton()).toHaveFocus())
})

test('Escape leaves the write-mode step without closing the dialog or sending anything', async () => {
  const onClose = vi.fn()
  renderManager({ onClose })
  await waitFor(() => expect(writeModeButton()).toBeEnabled())

  fireEvent.click(writeModeButton())
  fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), { key: 'Escape' })

  expect(writeModeButton()).toHaveAttribute('aria-pressed', 'false')
  expect(onClose).not.toHaveBeenCalled()
  expect(writeModeChanges()).toHaveLength(0)
})

test('a protected library is asked for its passphrase, and told when it is wrong', async () => {
  requiredPassphrase = 'synthetic-guard'
  renderManager()
  await waitFor(() => expect(writeModeButton()).toBeEnabled())

  fireEvent.click(writeModeButton())
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  // The field appears only once the server has asked for it: an unprotected
  // library must not be prompted for a passphrase it does not have.
  const field = await screen.findByLabelText('Passphrase for Movies')
  expect(field).toHaveFocus()
  expect(screen.queryByText(/not accepted/)).toBeNull()
  expect(screen.getByRole('button', { name: 'Turn on' })).toBeDisabled()

  fireEvent.change(field, { target: { value: 'guess' } })
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  expect(await screen.findByText('That passphrase was not accepted.')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Write mode for Movies' })).toBeNull()

  fireEvent.change(screen.getByLabelText('Passphrase for Movies'), {
    target: { value: 'synthetic-guard' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))
  expect(writeModeChanges().map((request) => request.body?.passphrase)).toEqual([
    null,
    'guess',
    'synthetic-guard',
  ])
})

test('turning write mode off is immediate and asks for nothing', async () => {
  libraries = [{ ...MOVIES, write_mode_enabled: true }]
  requiredPassphrase = 'synthetic-guard'
  renderManager()
  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))

  fireEvent.click(writeModeButton())

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'false'))
  expect(writeModeChanges().map((request) => request.body)).toEqual([
    { enabled: false, passphrase: null },
  ])
  expect(screen.queryByLabelText('Passphrase for Movies')).toBeNull()
})

test('a locked library turns write mode off with its passphrase', async () => {
  libraries = [{ ...MOVIES, write_mode_enabled: true }]
  requiredPassphrase = 'synthetic-guard'
  locked = true
  renderManager()
  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))

  fireEvent.click(writeModeButton())

  // The passphrase stands in for unlocking the library first
  const field = await screen.findByLabelText('Passphrase for Movies')
  expect(field).toHaveFocus()
  fireEvent.change(field, { target: { value: 'synthetic-guard' } })
  fireEvent.click(screen.getByRole('button', { name: 'Turn off' }))

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'false'))
  expect(writeModeChanges().map((request) => request.body)).toEqual([
    { enabled: false, passphrase: null },
    { enabled: false, passphrase: 'synthetic-guard' },
  ])
})

test('a failed change is reported in the row and the same switch retries it', async () => {
  libraries = [{ ...MOVIES, write_mode_enabled: true }]
  writeFailures = 1
  renderManager()
  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))

  fireEvent.click(writeModeButton())

  expect(await screen.findByText('Synthetic registry failure')).toBeInTheDocument()
  expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true')
  expect(writeModeButton()).toBeEnabled()

  fireEvent.click(writeModeButton())

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'false'))
  expect(screen.queryByText('Synthetic registry failure')).toBeNull()
})

test('turning on keeps its step after a failure, so Turn on retries the same intent', async () => {
  writeFailures = 1
  renderManager()
  await waitFor(() => expect(writeModeButton()).toBeEnabled())

  fireEvent.click(writeModeButton())
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  expect(await screen.findByText('Synthetic registry failure')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Turn on' }))

  await waitFor(() => expect(writeModeButton()).toHaveAttribute('aria-pressed', 'true'))
  expect(writeModeChanges().map((request) => request.body)).toEqual([
    { enabled: true, passphrase: null },
    { enabled: true, passphrase: null },
  ])
})

test('a server that does not allow write mode disables every switch and says why once', async () => {
  deploymentWriteMode = 'disabled'
  libraries = [MOVIES, TRIPS]
  renderManager()

  const note = await screen.findByText('This server does not allow write mode.')
  expect(writeModeButton()).toBeDisabled()
  expect(writeModeButton()).toHaveAttribute('aria-describedby', note.id)
  expect(screen.getByRole('button', { name: 'Write mode for Trips' })).toBeDisabled()
  expect(screen.getAllByText('This server does not allow write mode.')).toHaveLength(1)

  fireEvent.click(writeModeButton())

  expect(writeModeChanges()).toHaveLength(0)
})

test('a switch left on while the server forbids it says so and can still be turned off', async () => {
  deploymentWriteMode = 'disabled'
  libraries = [{ ...MOVIES, write_mode_enabled: true }]
  renderManager()

  await waitFor(() => expect(writeModeButton()).toHaveTextContent('Write mode: on (blocked)'))
  // The library's own flag is the owner's to clear
  expect(writeModeButton()).toBeEnabled()
})

test('a released library waits for Reopen before write mode can be turned on', async () => {
  ownershipState = 'locally_released'
  renderManager()

  expect(await screen.findByText('Released on this server')).toBeInTheDocument()
  await waitFor(() =>
    expect(writeModeButton()).toHaveAttribute(
      'title',
      'Reopen this library here to turn on write mode.',
    ),
  )
  expect(writeModeButton()).toBeDisabled()
})

test('an older portable package cannot change write mode, and says why', async () => {
  libraries = [{ ...MOVIES, schema_version: 1 }]
  renderManager()

  await waitFor(() =>
    expect(writeModeButton()).toHaveAttribute(
      'title',
      'Write mode needs the current library format.',
    ),
  )
  expect(writeModeButton()).toBeDisabled()
  expect(writeModeButton()).toHaveTextContent('Write mode: off')
})

test('an old-format library has no write mode until it is converted', async () => {
  libraries = [{ ...MOVIES, package_format: 'cairndex.library', status: 'unavailable' }]
  renderManager()

  await screen.findByRole('button', { name: 'Convert Movies' })
  expect(screen.queryByRole('button', { name: 'Write mode for Movies' })).toBeNull()
})

// --- library settings ----------------------------------------------------------

test('Settings… opens its own dialog over an intact list, and Escape returns to it', async () => {
  libraries = [MOVIES, TRIPS]
  const onClose = vi.fn()
  renderManager({ onClose })
  const opener = await screen.findByRole('button', { name: 'Settings for Movies' })
  opener.focus()
  fireEvent.click(opener)

  const settings = await screen.findByRole('dialog', { name: 'Movies settings' })
  expect(
    await within(settings).findByRole('heading', { name: 'Access on this server' }),
  ).toBeInTheDocument()
  // The list is hidden behind it, not replaced: both rows are still rows
  const list = screen
    .getByRole('heading', { name: 'Libraries', hidden: true })
    .closest('[role="dialog"]') as HTMLElement
  expect(list).not.toBeVisible()
  expect(within(list).getAllByRole('button', { name: /^Open /, hidden: true })).toHaveLength(2)
  expect(list).not.toContainElement(
    within(settings).getByRole('heading', { name: 'Access on this server' }),
  )

  fireEvent.keyDown(settings, { key: 'Escape' })

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Movies settings' })).toBeNull())
  expect(screen.getByRole('heading', { name: 'Libraries' })).toBeVisible()
  expect(onClose).not.toHaveBeenCalled()
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Settings for Movies' })).toHaveFocus(),
  )
})

test('Back returns to the list, and settings are not reopened by a later visit', async () => {
  const view = renderManager()
  fireEvent.click(await screen.findByRole('button', { name: 'Settings for Movies' }))
  const settings = await screen.findByRole('dialog', { name: 'Movies settings' })

  fireEvent.click(within(settings).getByRole('button', { name: 'Back to libraries' }))

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Movies settings' })).toBeNull())
  expect(screen.getByRole('button', { name: 'Write mode for Movies' })).toBeInTheDocument()

  // Left open when the dialog goes away, it is still not remembered
  fireEvent.click(screen.getByRole('button', { name: 'Settings for Movies' }))
  await screen.findByRole('dialog', { name: 'Movies settings' })
  view.unmount()
  renderManager()
  await screen.findByRole('button', { name: 'Settings for Movies' })
  expect(screen.queryByRole('dialog', { name: 'Movies settings' })).toBeNull()
  const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
  expect(keys.filter((key) => key?.includes('libraryControls'))).toEqual([])
})

test('settings descriptions stay short, with the explanations in tooltips', async () => {
  renderManager()
  fireEvent.click(await screen.findByRole('button', { name: 'Settings for Movies' }))
  const settings = await screen.findByRole('dialog', { name: 'Movies settings' })

  // The consequential sentence stays visible; the reasons are one focus away
  expect(await within(settings).findByText('Not a complete library backup.')).toBeVisible()
  const backups = within(settings).getByRole('button', { name: 'About private backups' })
  const explanation = document.getElementById(backups.getAttribute('aria-describedby')!)
  expect(explanation).toHaveTextContent(/source media, cloud-delivered metadata, credentials/)
  expect(explanation).not.toBeVisible()
  onScreen(backups)
  fireEvent.focus(backups)
  expect(explanation).toBeVisible()

  // Recovery says what gates Prepare, where the disabled button is
  expect(
    within(settings).getByText('Release the library before you prepare a recovery.'),
  ).toBeVisible()
  expect(within(settings).getByRole('button', { name: 'Prepare separate recovery' })).toBeDisabled()
})
