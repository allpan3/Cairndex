import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { QueryScope } from '../QueryScope'
import {
  activateConnection,
  addRemoteConnection,
  getConnections,
  loadConnections,
  subscribeConnections,
} from './connections'

import { fetchHealth, setApiBaseUrl } from '../api/client'
import {
  initializeHostPlatform,
  listenHostLifecycle,
  listenHostMenu,
  normalizeHostServerUrl,
  saveHostServerUrl,
  setHostServerAvailable,
} from '../platform'

interface DesktopBootstrapProps {
  children: React.ReactNode
}

interface SetupState {
  serverUrl: string
  error: string | null
}

const INCOMPATIBLE_SERVER_ERROR = 'This address is not a compatible Cairndex server.'
const REQUIRED_API_FEATURES = ['pairing', 'progress']

// Verifies that a normalized server URL reaches a live Cairndex backend
async function verifyServer(serverUrl: string): Promise<void> {
  setApiBaseUrl(serverUrl)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    const health = await fetchHealth(controller.signal)
    const compatible =
      health.status === 'ok' &&
      typeof health.app_name === 'string' &&
      health.app_name.length > 0 &&
      Array.isArray(health.api_features) &&
      REQUIRED_API_FEATURES.every((feature) => health.api_features.includes(feature))
    if (!compatible) throw new Error(INCOMPATIBLE_SERVER_ERROR)
  } finally {
    window.clearTimeout(timeout)
  }
}

// Surfaces recoverable desktop bridge failures without hiding the setup UI
function reportDesktopBridgeError(message: string, error: unknown): void {
  console.error(message, error)
}

// Gates the shared SPA on first-run desktop server configuration
export function DesktopBootstrap({ children }: DesktopBootstrapProps) {
  // Drives the QueryScope key below. Subscribed rather than kept in local state
  // so an activation from anywhere — the menu, a future connections UI — swaps
  // the scope without having to route through this component.
  const activeConnectionId = useSyncExternalStore(
    subscribeConnections,
    () => getConnections().activeConnectionId,
  )
  const [ready, setReady] = useState(false)
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [saving, setSaving] = useState(false)
  const serverInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void initializeHostPlatform()
      .then(() => listenHostLifecycle())
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) =>
        reportDesktopBridgeError('Could not start desktop lifecycle handling', error),
      )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  useEffect(() => {
    if (ready) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void initializeHostPlatform()
      .then(() =>
        listenHostMenu((action) => {
          if (action !== 'settings') return
          serverInputRef.current?.focus()
          serverInputRef.current?.select()
        }),
      )
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) =>
        reportDesktopBridgeError('Could not start desktop setup menu handling', error),
      )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [ready])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await initializeHostPlatform()
        await setHostServerAvailable(false)
      } catch (error) {
        reportDesktopBridgeError('Could not disable server menu actions during setup', error)
      }
      try {
        // Migrates a pre-D6 stored `serverUrl` into one active remote
        // connection, so an existing NAS setup sees no first-run change.
        const state = await loadConnections()
        if (!active) return
        const activeId = state.activeConnectionId
        const stored = state.connections.find((entry) => entry.id === activeId)?.serverUrl ?? null
        if (!activeId || !stored) {
          setSetup({ serverUrl: 'http://127.0.0.1:8000', error: null })
          return
        }
        try {
          await activateConnection(activeId)
          await verifyServer(stored)
          if (active) {
            try {
              await setHostServerAvailable(true)
            } catch (error) {
              reportDesktopBridgeError('Could not enable server menu actions', error)
            }
            setReady(true)
          }
        } catch (error) {
          if (active) {
            setSetup({
              serverUrl: stored,
              error:
                error instanceof Error && error.message === INCOMPATIBLE_SERVER_ERROR
                  ? error.message
                  : 'Cairndex did not respond at this address. Check that the server is running.',
            })
          }
        }
      } catch {
        if (active) {
          setSetup({
            serverUrl: 'http://127.0.0.1:8000',
            error: 'The desktop settings store could not be opened.',
          })
        }
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!setup || saving) return
    setSaving(true)
    setSetup({ ...setup, error: null })
    try {
      const normalized = await normalizeHostServerUrl(setup.serverUrl)
      const connection = await addRemoteConnection(normalized)
      await activateConnection(connection.id)
      await verifyServer(normalized)
      // Kept for now so a downgrade to a pre-D6 build still finds its server.
      await saveHostServerUrl(normalized)
      try {
        await setHostServerAvailable(true)
      } catch (error) {
        reportDesktopBridgeError('Could not enable server menu actions', error)
      }
      setReady(true)
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'string'
            ? error
            : 'Could not connect to this Cairndex server.'
      setSetup({ ...setup, error: message })
    } finally {
      setSaving(false)
    }
  }

  // Keyed on the active connection: a switch remounts the whole scope, so the
  // previous server's cache and any request still in flight against it are
  // discarded rather than left to resolve into the new connection's cache
  // (plan 3 §7.1 — library ids are per-server and not globally unique).
  if (ready) return <QueryScope key={activeConnectionId ?? 'initial'}>{children}</QueryScope>
  if (!setup) return <div className="app-loading">Loading desktop settings…</div>

  return (
    <main className="desktop-setup">
      <form className="desktop-setup__card" onSubmit={connect}>
        <img src="/favicon.svg" alt="" className="desktop-setup__mark" />
        <p className="desktop-setup__eyebrow">Cairndex desktop</p>
        <h1>Connect to your server</h1>
        <p className="desktop-setup__copy">
          Start Cairndex on this Mac or another private machine, then enter its URL.
        </p>
        <label className="field-label" htmlFor="desktop-server-url">
          Server URL
        </label>
        <input
          ref={serverInputRef}
          id="desktop-server-url"
          className="edit desktop-setup__input"
          type="url"
          value={setup.serverUrl}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          autoFocus
          onChange={(event) => setSetup({ serverUrl: event.target.value, error: null })}
        />
        {setup.error && (
          <div className="modal__error" role="alert">
            {setup.error}
          </div>
        )}
        <button className="btn btn--primary desktop-setup__submit" disabled={saving}>
          {saving ? 'Connecting…' : 'Connect'}
        </button>
        <p className="desktop-setup__hint">
          This address stays on this device and can point to localhost, a LAN host, or a private
          reverse proxy.
        </p>
      </form>
    </main>
  )
}
