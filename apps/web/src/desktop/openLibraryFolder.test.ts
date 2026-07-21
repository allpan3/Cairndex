import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  getActiveConnection,
  getConnections,
  getPendingSelectionVersion,
  subscribeConnections,
  loadConnections,
  resetConnectionsForTests,
  setPendingLibrarySelection,
  takePendingLibrarySelection,
  LOCAL_CONNECTION_ID,
} from './connections'
import { openLibraryFolder } from './openLibraryFolder'
import { resetJobNotificationsForTests } from './useJobNotifications'

const configureHostServer = vi.fn<(url: string, options?: unknown) => Promise<void>>()
const startHostLocalServer = vi.fn<() => Promise<{ baseUrl: string; token: string }>>()
const openHostLibraryFolder = vi.fn()
const loadHostConnections = vi.fn()
const saveHostConnections = vi.fn()
const loadHostServerUrl = vi.fn()

vi.mock('../platform', () => ({
  configureHostServer: (url: string, options?: unknown) => configureHostServer(url, options),
  startHostLocalServer: () => startHostLocalServer(),
  openHostLibraryFolder: () => openHostLibraryFolder(),
  loadHostConnections: () => loadHostConnections(),
  saveHostConnections: (value: unknown) => saveHostConnections(value),
  loadHostServerUrl: () => loadHostServerUrl(),
}))

const NAS = 'http://nas.local:8000'

// Reports whether a selection is queued, without consuming it.
function pendingCount(): string {
  const value = takePendingLibrarySelection(LOCAL_CONNECTION_ID)
  if (value === null) return 'empty'
  setPendingLibrarySelection(LOCAL_CONNECTION_ID, value)
  return 'queued'
}
const OPENED = { libraryId: 'lib-local-1', libraryUuid: 'uuid-1', displayName: 'Photos' }

beforeEach(() => {
  resetConnectionsForTests()
  resetJobNotificationsForTests()
  vi.clearAllMocks()
  configureHostServer.mockResolvedValue(undefined)
  saveHostConnections.mockResolvedValue(undefined)
  loadHostConnections.mockResolvedValue(null)
  loadHostServerUrl.mockResolvedValue(NAS)
  startHostLocalServer.mockResolvedValue({ baseUrl: 'http://127.0.0.1:54321', token: 'local-tok' })
  openHostLibraryFolder.mockResolvedValue(OPENED)
})

describe('openLibraryFolder', () => {
  it('activates the local connection and pre-selects the opened library', async () => {
    await loadConnections()

    const result = await openLibraryFolder()

    expect(result.opened).toEqual(OPENED)
    expect(getActiveConnection()?.id).toBe(LOCAL_CONNECTION_ID)
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe(OPENED.libraryId)
  })

  it('changes nothing at all when the picker is dismissed', async () => {
    // Cancel is not an error and not a change: the current connection, the
    // query scope, and the library selection all stay as they were.
    await loadConnections()
    const before = getActiveConnection()?.id
    openHostLibraryFolder.mockResolvedValue(null)

    const result = await openLibraryFolder()

    expect(result.opened).toBeNull()
    expect(getActiveConnection()?.id).toBe(before)
    expect(startHostLocalServer).not.toHaveBeenCalled()
    expect(configureHostServer).not.toHaveBeenCalled()
    expect(getConnections().connections.some((entry) => entry.kind === 'local')).toBe(false)
  })

  it('queues the selection before activating, not after', async () => {
    // Activation remounts the tree that consumes it, so queueing afterwards
    // would race the remount this exists to survive.
    await loadConnections()
    const seenAtConfigure: (string | null)[] = []
    configureHostServer.mockImplementation(async () => {
      // Peek without consuming: re-read after the call to confirm it survived.
      seenAtConfigure.push(pendingCount())
    })

    await openLibraryFolder()

    expect(seenAtConfigure).toEqual(['queued'])
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe(OPENED.libraryId)
  })

  it('scopes the pending selection to the connection it belongs to', async () => {
    // The same id string can exist on two servers, so a selection queued for the
    // local connection must never be consumed by the remote one.
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id

    await openLibraryFolder()

    expect(takePendingLibrarySelection(remoteId)).toBeNull()
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe(OPENED.libraryId)
  })

  it('hands the selection over exactly once', async () => {
    await loadConnections()
    await openLibraryFolder()

    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe(OPENED.libraryId)
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBeNull()
  })

  it('surfaces the shell’s reason when the folder is not a library', async () => {
    await loadConnections()
    openHostLibraryFolder.mockRejectedValue({
      code: 'open_failed',
      message: "'/x' is not a Cairndex library (no marker found)",
    })

    await expect(openLibraryFolder()).rejects.toMatchObject({
      message: expect.stringContaining('not a Cairndex library'),
    })
    // And the failure left the previous connection alone.
    expect(getActiveConnection()?.id).not.toBe(LOCAL_CONNECTION_ID)
  })

  it('leaves the previous connection active when the sidecar will not start', async () => {
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    startHostLocalServer.mockRejectedValue(new Error('sidecar refused'))

    await expect(openLibraryFolder()).rejects.toThrow('sidecar refused')

    expect(getActiveConnection()?.id).toBe(remoteId)
  })

  it('re-opening on the already-active connection still queues a selection', async () => {
    // Owner-reported: opening an *already registered* library did nothing the
    // second time. Activating a connection that is already active changes no
    // id, so nothing remounts and an effect keyed only on the connection never
    // re-runs. The queue version is what makes the second open observable.
    await loadConnections()
    await openLibraryFolder()
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe(OPENED.libraryId)

    const versionBefore = getPendingSelectionVersion()
    openHostLibraryFolder.mockResolvedValue({ ...OPENED, libraryId: 'lib-local-2' })

    await openLibraryFolder()

    expect(getActiveConnection()?.id).toBe(LOCAL_CONNECTION_ID)
    expect(getPendingSelectionVersion()).toBeGreaterThan(versionBefore)
    expect(takePendingLibrarySelection(LOCAL_CONNECTION_ID)).toBe('lib-local-2')
  })

  it('notifies subscribers when a selection is queued', async () => {
    await loadConnections()
    const seen: number[] = []
    const stop = subscribeConnections(() => seen.push(getPendingSelectionVersion()))

    await openLibraryFolder()
    stop()

    expect(seen.at(-1)).toBeGreaterThan(0)
  })

  it('works with no remote server ever configured', async () => {
    // The milestone's premise: a local folder opens without server admin, so
    // this must not depend on a prior connection existing.
    loadHostServerUrl.mockResolvedValue(null)
    await loadConnections()
    expect(getConnections().connections).toHaveLength(0)

    const result = await openLibraryFolder()

    expect(result.opened).toEqual(OPENED)
    expect(getActiveConnection()?.id).toBe(LOCAL_CONNECTION_ID)
  })
})
