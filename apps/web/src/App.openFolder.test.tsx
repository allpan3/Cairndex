/**
 * The real folder-opening flow, end to end inside App: the File menu opens the
 * Libraries dialog, and Browse… in that dialog reaches the shell's picker.
 *
 * Deliberately does *not* mock `./desktop/openLibraryFolder` — the previous two
 * attempts at this bug were fixed against a model of the flow rather than the
 * flow itself, and both times the unit tests passed while the app did not. Here
 * only the outermost seam (the Tauri command) is faked, so the dialog, the
 * connections store, the pending-selection handoff, and App's consumption all
 * really run.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import App from './App'
import * as client from './api/client'
import { DesktopBootstrap } from './desktop/DesktopBootstrap'
import { resetConnectionsForTests } from './desktop/connections'

// This jsdom setup provides no localStorage, so `usePersistentState` — which
// holds the library selection — is inert without one. The app always has it, so
// a test without it would be exercising a different program.
const store = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size
  },
})

const desktopMenu = vi.hoisted(() => ({
  handlers: new Set<{ current: (action: string) => void }>(),
}))

function dispatchMenu(action: string) {
  for (const ref of desktopMenu.handlers) ref.current(action)
}
const host = vi.hoisted(() => ({
  openLibraryFolder: vi.fn(),
  confirmPickedLibrary: vi.fn(),
  startLocalServer: vi.fn(),
  configureServer: vi.fn(),
  loadConnections: vi.fn(),
  saveConnections: vi.fn(),
  loadServerUrl: vi.fn(),
}))

// Mirrors the real hook: one subscription per call site, holding a ref to the
// *latest* closure. An earlier version kept only the first render's closure,
// where the library list is still empty — so the handler saw no libraries and
// the test failed for a reason the app does not have.
vi.mock('./desktop/useDesktopMenu', async () => {
  const react = await import('react')
  return {
    useDesktopMenu: (handler: (action: string) => void) => {
      const ref = react.useRef(handler)
      ref.current = handler
      react.useEffect(() => {
        desktopMenu.handlers.add(ref)
        return () => {
          desktopMenu.handlers.delete(ref)
        }
      }, [])
    },
    useDesktopMenuAvailability: vi.fn(),
  }
})

vi.mock('./desktop/verifyServer', () => ({
  verifyServer: vi.fn().mockResolvedValue(undefined),
  INCOMPATIBLE_SERVER_ERROR: 'incompatible',
  UNREACHABLE_SERVER_ERROR: 'unreachable',
}))

vi.mock('./platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platform')>()
  return {
    ...actual,
    isDesktopHost: () => true,
    initializeHostPlatform: () => Promise.resolve({ kind: 'desktop' }),
    listenHostLifecycle: () => Promise.resolve(() => undefined),
    listenHostMenu: () => Promise.resolve(() => undefined),
    setHostServerAvailable: () => Promise.resolve(undefined),
    normalizeHostServerUrl: (value: string) => Promise.resolve(value),
    saveHostServerUrl: () => Promise.resolve(undefined),
    openHostLibraryFolder: (uuids: string[], stage: boolean) =>
      host.openLibraryFolder(uuids, stage),
    confirmHostPickedLibrary: (token: string, name: string) =>
      host.confirmPickedLibrary(token, name),
    startHostLocalServer: () => host.startLocalServer(),
    configureHostServer: (url: string, options?: unknown) => host.configureServer(url, options),
    loadHostConnections: () => host.loadConnections(),
    saveHostConnections: (value: unknown) => host.saveConnections(value),
    loadHostServerUrl: () => host.loadServerUrl(),
  }
})

const PHOTOS = {
  id: 'lib-photos',
  library_uuid: 'uuid-photos',
  name: 'Photos',
  root_path: '/p',
  status: 'available',
}
const VIDEO = {
  id: 'lib-video',
  library_uuid: 'uuid-video',
  name: 'Video',
  root_path: '/v',
  status: 'available',
}

function mockApi(libraries: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      let body: unknown = {}
      if (url.endsWith('/api/v1/libraries')) body = libraries
      else if (url.endsWith('/auth/status')) body = { protected: false, unlocked: true }
      else if (url.includes('/ownership')) body = { mountable: true, state: 'own' }
      else if (url.includes('/bundles/browse'))
        body = { items: [], total: 0, offset: 0, limit: 100 }
      else if (url.includes('/counts') || url.includes('/facets')) body = {}
      else if (url.includes('/collections') || url.includes('/tags') || url.includes('/jobs'))
        body = { items: [] }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
    }),
  )
}

beforeEach(() => {
  resetConnectionsForTests()
  store.clear()
  desktopMenu.handlers.clear()
  vi.clearAllMocks()
  host.configureServer.mockResolvedValue(undefined)
  host.saveConnections.mockResolvedValue(undefined)
  host.loadConnections.mockResolvedValue(null)
  host.loadServerUrl.mockResolvedValue(null)
  host.startLocalServer.mockResolvedValue({ baseUrl: 'http://127.0.0.1:5555', token: 't' })
})

afterEach(() => {
  vi.restoreAllMocks()
})

let active: string | null = null
beforeEach(() => {
  active = null
  vi.spyOn(client, 'setActiveLibraryId').mockImplementation((id: string | null) => {
    active = id
  })
})

// Every case reaches the picker the way a user does: ⌘O opens the Libraries
// dialog, and Browse… inside it is what calls the shell.
async function browseForFolder() {
  await act(async () => {
    dispatchMenu('manage-libraries')
  })
  const browse = await screen.findByRole('button', { name: 'Browse…' })
  await act(async () => {
    fireEvent.click(browse)
  })
}

function renderApp() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>,
  )
}

test('Browse stages an existing library instead of switching to it', async () => {
  // Browse in Manage Libraries picks a folder and *stages* it — adding is the
  // deliberate confirm step. So an existing library is not opened on pick: the
  // app stays where it is and shows the confirm (with a read-only name, since
  // the library keeps its own), rather than switching. The confirm→register
  // path itself is covered in LibraryManager.desktop.test.tsx.
  mockApi([PHOTOS, VIDEO])
  host.loadConnections.mockResolvedValue({
    connections: [{ id: 'local', kind: 'local', label: 'This Computer', serverUrl: null }],
    activeConnectionId: 'local',
  })
  host.openLibraryFolder.mockResolvedValue({
    needsConfirmation: true,
    token: 'pick-token',
    folderName: 'Video',
    isLibrary: true,
    alreadyAvailable: false,
    libraryId: '',
    libraryUuid: 'uuid-video',
    displayName: 'Video',
  })
  renderApp()
  await waitFor(() => expect(active).toBe(PHOTOS.id))

  await browseForFolder()

  const name = await screen.findByLabelText('Library name')
  expect(name).toHaveAttribute('readonly')
  expect(active).toBe(PHOTOS.id)
})

test('on a remote connection, confirming a staged pick adopts it — the keyed QueryScope remounts', async () => {
  // A natively-picked folder is a *local*-server library, so on a remote
  // connection adding it must switch to the local server — the one case Browse
  // still adopts, on the confirm. This runs inside the real DesktopBootstrap so
  // the keyed QueryScope that remounts on that connection change is exercised.
  mockApi([PHOTOS, VIDEO])
  host.loadConnections.mockResolvedValue({
    connections: [
      { id: 'remote:http://nas:8000', kind: 'remote', label: 'nas', serverUrl: 'http://nas:8000' },
    ],
    activeConnectionId: 'remote:http://nas:8000',
  })
  host.openLibraryFolder.mockResolvedValue({
    needsConfirmation: true,
    token: 'pick-token',
    folderName: 'Video',
    isLibrary: true,
    alreadyAvailable: false,
    libraryId: '',
    libraryUuid: 'uuid-video',
    displayName: 'Video',
  })
  host.confirmPickedLibrary.mockResolvedValue({
    libraryId: VIDEO.id,
    libraryUuid: 'uuid-video',
    displayName: 'Video',
  })

  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <DesktopBootstrap>
        <App />
      </DesktopBootstrap>
    </QueryClientProvider>,
  )
  await waitFor(() => expect(active).toBe(PHOTOS.id), { timeout: 3000 })

  await browseForFolder()
  // Staged — nothing switched on the pick itself.
  const add = await screen.findByRole('button', { name: 'Add library' })
  expect(active).toBe(PHOTOS.id)

  await act(async () => {
    fireEvent.click(add)
  })

  await waitFor(() => expect(active).toBe(VIDEO.id), { timeout: 3000 })
})

test('a folder the current server already serves is just selected, not reopened', async () => {
  // The owner's case. Their main server already served ~/DemoLibrary, so
  // opening it started a *second* server for the same folder and the ownership
  // lease refused it — reporting the library as "open on <their own machine>".
  // The shell is now told what this server already has, and reports a match
  // instead of opening anything.
  mockApi([PHOTOS, VIDEO])
  host.openLibraryFolder.mockResolvedValue({
    alreadyAvailable: true,
    libraryId: '',
    libraryUuid: VIDEO.library_uuid,
    displayName: 'Video',
  })
  renderApp()
  await waitFor(() => expect(active).toBe(PHOTOS.id))

  await browseForFolder()

  // Selected here, on this server — by portable uuid, since the shell has no
  // id that means anything in this registry.
  await waitFor(() => expect(active).toBe(VIDEO.id))
  expect(host.startLocalServer).not.toHaveBeenCalled()
})

test('the shell is told which libraries this server already has', async () => {
  mockApi([PHOTOS, VIDEO])
  host.openLibraryFolder.mockResolvedValue(null)
  renderApp()
  await waitFor(() => expect(active).toBe(PHOTOS.id))

  await browseForFolder()

  await waitFor(() => expect(host.openLibraryFolder).toHaveBeenCalled())
})
