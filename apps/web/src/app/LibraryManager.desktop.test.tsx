import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { LibraryRead } from '../api/client'
import type { OpenedLibrary } from '../platform'
import { LibraryManager } from './LibraryManager'

// The desktop half: `Browse…` reaches the same three outcomes as a typed path,
// and a folder that is not a library yet is named through the same confirmation
// — while the folder's absolute path never enters this layer. All the web ever
// holds is the opaque token the shell minted for that pick.

const openHostFolder = vi.fn()
const confirmHostPick = vi.fn()
vi.mock('../desktop/openLibraryFolder', () => ({
  openLibraryFolder: (uuids: string[]) => openHostFolder(uuids),
  confirmPickedLibrary: (token: string, name: string) => confirmHostPick(token, name),
}))

vi.mock('../platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../platform')>()),
  isDesktopHost: () => true,
}))

const MOVIES: LibraryRead = {
  id: 'lib-movies',
  library_uuid: '01J00000000000000000000000',
  name: 'Movies',
  root_path: '/srv/movies',
  status: 'available',
  schema_version: 1,
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
  root_path: '/synthetic/trips',
}

const NEEDS_NAME: OpenedLibrary = {
  needsConfirmation: true,
  token: 'pick-token-1',
  folderName: 'Holiday Videos',
  isLibrary: false,
  alreadyAvailable: false,
  libraryId: '',
  libraryUuid: '',
  displayName: null,
}

let listedLibraries: LibraryRead[]
let listFailures: number

beforeEach(() => {
  listedLibraries = [MOVIES]
  listFailures = 0
  vi.clearAllMocks()
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      const reply = (body: unknown, status = 200) =>
        Promise.resolve({
          ok: status >= 200 && status < 300,
          status,
          json: () => Promise.resolve(body),
        } as Response)
      if (url.startsWith('/api/v1/libraries/path-suggestions')) return reply({ suggestions: [] })
      if (url === '/api/v1/libraries') {
        if (listFailures > 0) {
          listFailures -= 1
          return reply({ message: 'Synthetic library-list failure' }, 502)
        }
        return reply(listedLibraries)
      }
      throw new Error(`unexpected request: ${url}`)
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderManager(handlers: { onClose?: () => void; onSelect?: (id: string) => void } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <LibraryManager
        onClose={handlers.onClose ?? (() => undefined)}
        onSelect={handlers.onSelect}
      />
    </QueryClientProvider>,
  )
}

test('native confirmation refreshes the list, shows the library, and restores Add', async () => {
  openHostFolder.mockResolvedValue({ opened: NEEDS_NAME })
  confirmHostPick.mockImplementation(() => {
    listedLibraries = [MOVIES, TRIPS]
    return Promise.resolve({ opened: { ...NEEDS_NAME, needsConfirmation: false } })
  })
  const onClose = vi.fn()
  renderManager({ onClose })

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  const name = await screen.findByLabelText('Library name')
  expect(name).toHaveValue('Holiday Videos')
  // Nothing has been created yet — the shell is only holding the folder.
  expect(confirmHostPick).not.toHaveBeenCalled()

  fireEvent.change(name, { target: { value: 'Trips' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create library' }))

  await waitFor(() => expect(confirmHostPick).toHaveBeenCalledWith('pick-token-1', 'Trips'))
  // On the local connection an add is not a switch: the library joins the list
  // and the dialog stays open on the add form, rather than closing.
  expect(await screen.findByText('Trips')).toBeInTheDocument()
  await screen.findByLabelText('Library path')
  expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
  expect(onClose).not.toHaveBeenCalled()
})

test('picking an existing library folder stages it, and Add registers without switching', async () => {
  // A folder that is already a library the current server does not have: the
  // shell parks it (needsConfirmation, isLibrary) rather than adding it, so the
  // owner still clicks Add. The name is read-only — the library keeps its own.
  openHostFolder.mockResolvedValue({
    opened: {
      needsConfirmation: true,
      token: 'pick-token-lib',
      folderName: 'Trips',
      isLibrary: true,
      alreadyAvailable: false,
      libraryId: '',
      libraryUuid: '01J99999999999999999999999',
      displayName: 'Trips',
    } satisfies OpenedLibrary,
  })
  confirmHostPick.mockImplementation(() => {
    listedLibraries = [MOVIES, TRIPS]
    return Promise.resolve({ opened: { ...NEEDS_NAME, needsConfirmation: false } })
  })
  const onClose = vi.fn()
  const onSelect = vi.fn()
  renderManager({ onClose, onSelect })
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  // Nothing added yet — staged, with an explicit Add and a read-only name.
  const name = await screen.findByLabelText('Library name')
  expect(name).toHaveAttribute('readonly')
  expect(confirmHostPick).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  await waitFor(() => expect(confirmHostPick).toHaveBeenCalledWith('pick-token-lib', 'Trips'))
  // Added, not switched: the dialog stays open and nothing was selected.
  await screen.findByLabelText('Library path')
  expect(onSelect).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

test('a failed post-registration refresh cannot repeat the native add', async () => {
  openHostFolder.mockResolvedValue({
    opened: {
      ...NEEDS_NAME,
      token: 'pick-token-lib',
      folderName: 'Trips',
      isLibrary: true,
      libraryUuid: TRIPS.library_uuid,
    },
  })
  confirmHostPick.mockImplementation(() => {
    listedLibraries = [MOVIES, TRIPS]
    listFailures = 1
    return Promise.resolve({ opened: { ...NEEDS_NAME, needsConfirmation: false } })
  })
  renderManager()
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
  await screen.findByLabelText('Library name')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))

  expect(
    await screen.findByText('The library was added, but the library list could not be refreshed.'),
  ).toBeInTheDocument()
  expect(screen.getByText('“Trips” was added. Refresh the list to finish.')).toBeInTheDocument()
  expect(confirmHostPick).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Add library' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry refresh' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
})

test('Retry refresh shows the added library without registering it again', async () => {
  openHostFolder.mockResolvedValue({
    opened: {
      ...NEEDS_NAME,
      token: 'pick-token-lib',
      folderName: 'Trips',
      isLibrary: true,
      libraryUuid: TRIPS.library_uuid,
    },
  })
  confirmHostPick.mockImplementation(() => {
    listedLibraries = [MOVIES, TRIPS]
    listFailures = 1
    return Promise.resolve({ opened: { ...NEEDS_NAME, needsConfirmation: false } })
  })
  renderManager()
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
  await screen.findByLabelText('Library name')
  fireEvent.click(screen.getByRole('button', { name: 'Add library' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry refresh' }))

  expect(await screen.findByText('Trips')).toBeInTheDocument()
  expect(screen.getByLabelText('Library path')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
  expect(confirmHostPick).toHaveBeenCalledTimes(1)
})

test('an initial library-list failure is explicit and retryable', async () => {
  listFailures = 1
  renderManager()

  expect(await screen.findByText('The library list could not be loaded.')).toBeInTheDocument()
  expect(screen.queryByText(/No libraries yet/)).not.toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Library path'), { target: { value: '/synthetic/new' } })
  expect(screen.getByRole('button', { name: 'Add library' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Browse…' })).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

  expect(await screen.findByText('Movies')).toBeInTheDocument()
  expect(screen.queryByText('The library list could not be loaded.')).not.toBeInTheDocument()
})

test('cancelling the name step creates nothing', async () => {
  openHostFolder.mockResolvedValue({ opened: NEEDS_NAME })
  const onClose = vi.fn()
  renderManager({ onClose })

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

  expect(confirmHostPick).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
  // Back to the ordinary add form.
  expect(screen.getByLabelText('Library path')).toBeInTheDocument()
})

test('picking a library the current server already serves selects it here', async () => {
  openHostFolder.mockResolvedValue({
    opened: {
      needsConfirmation: false,
      token: null,
      folderName: null,
      alreadyAvailable: true,
      isLibrary: true,
      libraryId: '',
      libraryUuid: MOVIES.library_uuid,
      displayName: 'Movies',
    } satisfies OpenedLibrary,
  })
  const onSelect = vi.fn()
  renderManager({ onSelect })
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  await waitFor(() => expect(onSelect).toHaveBeenCalledWith(MOVIES.id))
})

test('tells the shell which libraries this server already has', async () => {
  openHostFolder.mockResolvedValue({ opened: null })
  renderManager()
  await screen.findByText('Movies')

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  // Without this the shell would start a second server against a folder the
  // current one already serves, which the ownership lease then refuses.
  await waitFor(() => expect(openHostFolder).toHaveBeenCalledWith([MOVIES.library_uuid]))
})

test('cancelling the picker changes nothing', async () => {
  openHostFolder.mockResolvedValue({ opened: null })
  const onClose = vi.fn()
  const onSelect = vi.fn()
  renderManager({ onClose, onSelect })

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  await waitFor(() => expect(openHostFolder).toHaveBeenCalled())
  expect(onClose).not.toHaveBeenCalled()
  expect(onSelect).not.toHaveBeenCalled()
  expect(screen.queryByLabelText('Library name')).toBeNull()
})

test('a failed pick is reported in the dialog, not swallowed', async () => {
  // This used to be a toast raised by the menu handler. The dialog owns the
  // whole flow now, so it owns the failure too.
  openHostFolder.mockRejectedValue({
    code: 'open_failed',
    message: "'/x' is not a Cairndex library (no marker found)",
  })
  const onClose = vi.fn()
  renderManager({ onClose })

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))

  expect(await screen.findByText(/not a Cairndex library/)).toBeInTheDocument()
  // And the dialog stays open, so the reason is readable and retryable.
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Library path')).toBeInTheDocument()
})

test('a failed confirmation is reported and the folder can be named again', async () => {
  openHostFolder.mockResolvedValue({ opened: NEEDS_NAME })
  confirmHostPick.mockRejectedValue({
    code: 'pick_expired',
    message: 'That folder selection is no longer available. Choose the folder again.',
  })
  renderManager()

  fireEvent.click(screen.getByRole('button', { name: 'Browse…' }))
  await screen.findByLabelText('Library name')
  fireEvent.click(screen.getByRole('button', { name: 'Create library' }))

  expect(await screen.findByText(/no longer available/)).toBeInTheDocument()
  expect(screen.getByLabelText('Library name')).toBeInTheDocument()
})
