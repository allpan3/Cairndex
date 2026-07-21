import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateConnection,
  addRemoteConnection,
  ensureLocalConnection,
  getActiveConnection,
  getConnections,
  loadConnections,
  resetConnectionsForTests,
  LOCAL_CONNECTION_ID,
} from './connections'
import {
  peekJobRunForTests,
  resetJobNotificationsForTests,
  setJobRunForTests,
} from './useJobNotifications'

const configureHostServer = vi.fn<(url: string, options?: unknown) => Promise<void>>()
const startHostLocalServer = vi.fn<() => Promise<{ baseUrl: string; token: string }>>()
const loadHostConnections = vi.fn()
const saveHostConnections = vi.fn()
const loadHostServerUrl = vi.fn()

vi.mock('../platform', () => ({
  configureHostServer: (url: string, options?: unknown) => configureHostServer(url, options),
  startHostLocalServer: () => startHostLocalServer(),
  loadHostConnections: () => loadHostConnections(),
  saveHostConnections: (value: unknown) => saveHostConnections(value),
  loadHostServerUrl: () => loadHostServerUrl(),
}))

const NAS = 'http://nas.local:8000'

beforeEach(() => {
  resetConnectionsForTests()
  resetJobNotificationsForTests()
  vi.clearAllMocks()
  configureHostServer.mockResolvedValue(undefined)
  saveHostConnections.mockResolvedValue(undefined)
  loadHostConnections.mockResolvedValue(null)
  loadHostServerUrl.mockResolvedValue(null)
  startHostLocalServer.mockResolvedValue({ baseUrl: 'http://127.0.0.1:54321', token: 'local-tok' })
})

describe('migration', () => {
  it('turns a pre-D6 stored server URL into one active remote connection', async () => {
    // Someone who already configured a NAS must see no first-run change.
    loadHostServerUrl.mockResolvedValue(NAS)

    const state = await loadConnections()

    expect(state.connections).toHaveLength(1)
    expect(state.connections[0]).toMatchObject({ kind: 'remote', serverUrl: NAS })
    expect(state.activeConnectionId).toBe(state.connections[0]?.id)
  })

  it('labels a migrated connection by host so it is recognizable in a list', async () => {
    loadHostServerUrl.mockResolvedValue(NAS)
    const state = await loadConnections()
    expect(state.connections[0]?.label).toBe('nas.local:8000')
  })

  it('prefers stored connections over the legacy key once they exist', async () => {
    loadHostServerUrl.mockResolvedValue(NAS)
    loadHostConnections.mockResolvedValue({
      connections: [{ id: 'remote:a', kind: 'remote', label: 'A', serverUrl: 'http://a' }],
      activeConnectionId: 'remote:a',
    })

    const state = await loadConnections()

    expect(state.connections).toHaveLength(1)
    expect(state.connections[0]?.serverUrl).toBe('http://a')
  })

  it('recovers when the stored active id names nothing', async () => {
    // Otherwise the app presents as "connected to nothing" with no way back.
    loadHostConnections.mockResolvedValue({
      connections: [{ id: 'remote:a', kind: 'remote', label: 'A', serverUrl: 'http://a' }],
      activeConnectionId: 'remote:gone',
    })

    const state = await loadConnections()

    expect(state.activeConnectionId).toBe('remote:a')
  })

  it('starts empty when nothing was ever configured', async () => {
    const state = await loadConnections()
    expect(state).toEqual({ connections: [], activeConnectionId: null })
  })
})

describe('activation', () => {
  it('configures transport before the active connection moves', async () => {
    // Observed across a real switch: start on the remote, activate the local,
    // and check what the active id is *at the moment* transport is configured.
    // If the commit happened first, a failure there would strand the app on a
    // connection whose transport was never set up.
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await activateConnection(remoteId)
    await ensureLocalConnection()

    const seen: (string | null)[] = []
    configureHostServer.mockImplementation(async () => {
      seen.push(getActiveConnection()?.id ?? null)
    })

    await activateConnection(LOCAL_CONNECTION_ID)

    expect(seen).toEqual([remoteId])
    expect(getActiveConnection()?.id).toBe(LOCAL_CONNECTION_ID)
  })

  it('leaves the previous connection fully intact when the sidecar will not start', async () => {
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await activateConnection(remoteId)
    await ensureLocalConnection()
    configureHostServer.mockClear()

    startHostLocalServer.mockRejectedValue(new Error('sidecar refused to start'))

    await expect(activateConnection(LOCAL_CONNECTION_ID)).rejects.toThrow('sidecar refused')

    // Still the remote, and transport was never touched — the failure happened
    // before any step with an effect.
    expect(getActiveConnection()?.id).toBe(remoteId)
    expect(configureHostServer).not.toHaveBeenCalled()
  })

  it('re-points transport at the previous server when configuring the new one fails', async () => {
    // The media relay rotates its capability route on every reconfigure, so a
    // failure after that step would otherwise leave the previous connection
    // alive but with dead media URLs.
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await activateConnection(remoteId)
    await ensureLocalConnection()

    configureHostServer.mockClear()
    configureHostServer.mockRejectedValueOnce(new Error('relay unavailable'))

    await expect(activateConnection(LOCAL_CONNECTION_ID)).rejects.toThrow('relay unavailable')

    expect(getActiveConnection()?.id).toBe(remoteId)
    // Second call is the compensating restore, aimed at the old server.
    expect(configureHostServer).toHaveBeenCalledTimes(2)
    expect(configureHostServer.mock.calls[1]?.[0]).toBe(NAS)
  })

  it('passes the sidecar token only for the local connection', async () => {
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await ensureLocalConnection()

    await activateConnection(LOCAL_CONNECTION_ID)
    expect(configureHostServer).toHaveBeenLastCalledWith('http://127.0.0.1:54321', {
      localToken: 'local-tok',
    })

    await activateConnection(remoteId)
    expect(configureHostServer).toHaveBeenLastCalledWith(NAS, { localToken: null })
  })

  it('never persists a URL for the managed local connection', async () => {
    // The sidecar's port is ephemeral; a stored one would be a lie next launch.
    await ensureLocalConnection()
    await activateConnection(LOCAL_CONNECTION_ID)

    const saved = saveHostConnections.mock.calls.at(-1)?.[0] as {
      connections: { kind: string; serverUrl: string | null }[]
    }
    expect(saved.connections.find((entry) => entry.kind === 'local')?.serverUrl).toBeNull()
  })
})

describe('serialization', () => {
  it('starts the sidecar exactly once for concurrent activations of the same connection', async () => {
    // A menu double-click, or StrictMode double-invoking an effect.
    await ensureLocalConnection()
    let release: (() => void) | undefined
    startHostLocalServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ baseUrl: 'http://127.0.0.1:1', token: 't' })
        }),
    )

    const first = activateConnection(LOCAL_CONNECTION_ID)
    const second = activateConnection(LOCAL_CONNECTION_ID)
    release?.()
    await Promise.all([first, second])

    expect(startHostLocalServer).toHaveBeenCalledTimes(1)
    expect(configureHostServer).toHaveBeenCalledTimes(1)
  })

  it('rejects a different activation while one is in flight rather than queueing it', async () => {
    // Queueing would eventually run a switch the user has already navigated past.
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await ensureLocalConnection()

    let release: (() => void) | undefined
    startHostLocalServer.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ baseUrl: 'http://127.0.0.1:1', token: 't' })
        }),
    )

    const local = activateConnection(LOCAL_CONNECTION_ID)
    await expect(activateConnection(remoteId)).rejects.toThrow('already being opened')

    release?.()
    await local
    expect(getActiveConnection()?.id).toBe(LOCAL_CONNECTION_ID)
  })

  it('allows a new activation once the previous one settles', async () => {
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await ensureLocalConnection()

    await activateConnection(LOCAL_CONNECTION_ID)
    await activateConnection(remoteId)

    expect(getActiveConnection()?.id).toBe(remoteId)
  })

  it('clears the in-flight slot after a failure so a retry is possible', async () => {
    await ensureLocalConnection()
    startHostLocalServer.mockRejectedValueOnce(new Error('nope'))
    await expect(activateConnection(LOCAL_CONNECTION_ID)).rejects.toThrow('nope')

    startHostLocalServer.mockResolvedValue({ baseUrl: 'http://127.0.0.1:2', token: 't' })
    await expect(activateConnection(LOCAL_CONNECTION_ID)).resolves.toMatchObject({ kind: 'local' })
  })
})

describe('job-run state across a switch', () => {
  it('drops a run in flight but keeps the notification permission', async () => {
    // Run state is module-scoped by D5b design so a *library* switch does not
    // lose a run in flight. That is exactly why a *connection* switch must
    // clear it: otherwise a run started on the previous server settles here and
    // notifies about work the user is no longer looking at. The OS permission
    // prompt is per-app, though, so re-asking on every switch would be nagging.
    loadHostServerUrl.mockResolvedValue(NAS)
    await loadConnections()
    const remoteId = getConnections().connections[0]!.id
    await activateConnection(remoteId)
    await ensureLocalConnection()

    setJobRunForTests({ startedAt: 1, askedPermission: true })
    expect(peekJobRunForTests().run).not.toBeNull()

    await activateConnection(LOCAL_CONNECTION_ID)

    expect(peekJobRunForTests().run).toBeNull()
    expect(peekJobRunForTests().askedPermission).toBe(true)
  })
})

describe('adding connections', () => {
  it('does not duplicate a remote server already in the set', async () => {
    const first = await addRemoteConnection(NAS)
    const second = await addRemoteConnection(NAS)
    expect(second.id).toBe(first.id)
    expect(getConnections().connections).toHaveLength(1)
  })

  it('keeps a single managed local entry', async () => {
    await ensureLocalConnection()
    await ensureLocalConnection()
    expect(getConnections().connections.filter((entry) => entry.kind === 'local')).toHaveLength(1)
  })
})
