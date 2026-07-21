/**
 * Where JSON API requests actually go after an activation — success or failure.
 *
 * Deliberately uses the REAL `verifyServer` and the REAL `api/client` module
 * state, mocking only the health transport and the platform seam. The main
 * connections suite mocks `verifyServer` wholesale, which is exactly why the
 * defect these tests pin survived it: activation *ordering* was proven while
 * nothing ever observed where a request would land. A local activation left
 * the API base on the previous remote server (or unset on first run), and a
 * failed activation left it on the dead server the probe had just touched.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  activateConnection,
  addRemoteConnection,
  ensureLocalConnection,
  loadConnections,
  resetConnectionsForTests,
  LOCAL_CONNECTION_ID,
} from './connections'
import { resetJobNotificationsForTests } from './useJobNotifications'
import { resolveApiUrl, setApiBaseUrl } from '../api/client'

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

// Real verifyServer; only the health transport is faked.
const fetchHealth = vi.fn()
vi.mock('../api/client', async (importOriginal) => {
  const real = await importOriginal<typeof import('../api/client')>()
  return {
    ...real,
    fetchHealth: (signal?: AbortSignal, baseUrl?: string) => fetchHealth(signal, baseUrl),
  }
})

const NAS = 'http://nas.local:8000'
const SIDECAR = 'http://127.0.0.1:54321'
const HEALTHY = { status: 'ok', app_name: 'cairndex', api_features: ['pairing', 'progress'] }

beforeEach(() => {
  resetConnectionsForTests()
  resetJobNotificationsForTests()
  vi.clearAllMocks()
  setApiBaseUrl(null)
  configureHostServer.mockResolvedValue(undefined)
  saveHostConnections.mockResolvedValue(undefined)
  loadHostConnections.mockResolvedValue(null)
  loadHostServerUrl.mockResolvedValue(null)
  startHostLocalServer.mockResolvedValue({ baseUrl: SIDECAR, token: 'local-tok' })
  fetchHealth.mockResolvedValue(HEALTHY)
})

describe('activation owns the API base URL', () => {
  it('a local activation points the API base at the sidecar', async () => {
    await loadConnections()
    const nas = await addRemoteConnection(NAS)
    await activateConnection(nas.id)
    expect(resolveApiUrl('/api/v1/libraries')).toBe(`${NAS}/api/v1/libraries`)

    await ensureLocalConnection()
    await activateConnection(LOCAL_CONNECTION_ID)

    expect(resolveApiUrl('/api/v1/libraries')).toBe(`${SIDECAR}/api/v1/libraries`)
  })

  it('a first-run local activation needs no remote to have ever existed', async () => {
    await loadConnections()
    await ensureLocalConnection()
    await activateConnection(LOCAL_CONNECTION_ID)

    expect(resolveApiUrl('/api/v1/libraries')).toBe(`${SIDECAR}/api/v1/libraries`)
  })

  it('a failed activation leaves the API base on the previous connection', async () => {
    await loadConnections()
    const nas = await addRemoteConnection(NAS)
    await activateConnection(nas.id)

    const dead = await addRemoteConnection('http://dead.local:9999')
    fetchHealth.mockRejectedValueOnce(new Error('connection refused'))
    await expect(activateConnection(dead.id)).rejects.toThrow()

    // The still-mounted workspace keeps querying the server the UI still shows.
    expect(resolveApiUrl('/api/v1/libraries')).toBe(`${NAS}/api/v1/libraries`)
  })

  it('probing a candidate server does not move the base (verify is pure)', async () => {
    await loadConnections()
    const nas = await addRemoteConnection(NAS)
    await activateConnection(nas.id)

    const dead = await addRemoteConnection('http://dead.local:9999')
    fetchHealth.mockRejectedValueOnce(new Error('connection refused'))
    await expect(activateConnection(dead.id)).rejects.toThrow()

    // The probe asked the candidate directly instead of repointing the module.
    expect(fetchHealth).toHaveBeenLastCalledWith(expect.anything(), 'http://dead.local:9999')
  })

  it('a failed transport switch away from local restores the local transport', async () => {
    await loadConnections()
    await ensureLocalConnection()
    await activateConnection(LOCAL_CONNECTION_ID)

    const nas = await addRemoteConnection(NAS)
    // The relay reconfigure is the one step with an effect outside module
    // state; failing it exercises the compensation path.
    configureHostServer.mockImplementation((url: string) =>
      url === NAS ? Promise.reject(new Error('relay reconfigure failed')) : Promise.resolve(),
    )
    await expect(activateConnection(nas.id)).rejects.toThrow('relay reconfigure failed')

    expect(resolveApiUrl('/api/v1/libraries')).toBe(`${SIDECAR}/api/v1/libraries`)
    // The compensation re-supplied the local token rather than silently
    // skipping the URL-less local connection.
    expect(configureHostServer).toHaveBeenLastCalledWith(SIDECAR, { localToken: 'local-tok' })
  })
})
