import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { QueryScope } from '../QueryScope'
import { NewLibraryDialog } from '../app/LibraryManager'
import { INCOMPATIBLE_SERVER_ERROR } from './verifyServer'
import { confirmPickedLibrary, openLibraryFolder } from './openLibraryFolder'
import {
  activateConnection,
  addRemoteConnection,
  getConnections,
  loadConnections,
  subscribeConnections,
} from './connections'

import {
  hostOperationErrorMessage,
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

// A folder picked from the File menu during first-run setup, awaiting a name.
// `token` stands in for the path, which stays inside the shell.
interface NamingState {
  token: string
  folderName: string
  busy: boolean
  error: string | null
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
  const [naming, setNaming] = useState<NamingState | null>(null)
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
          if (action === 'manage-libraries') {
            // Deliberately reachable from the first-run screen: opening a local
            // folder starts its own server, so it must not require a remote one
            // to have been configured first.
            //
            // This is the one state where the item does *not* open the Libraries
            // dialog: that dialog lists a server's libraries, and here there is
            // no server — which is the whole situation the picker resolves.
            void openLibraryFolder()
              .then((result) => {
                // A folder that is not a library yet needs a name before
                // anything exists to become ready *for*. App owns that dialog
                // once the workspace is up, but it is not mounted here, so the
                // setup screen asks the same question itself.
                if (result.opened?.needsConfirmation && result.opened.token) {
                  setNaming({
                    token: result.opened.token,
                    folderName: result.opened.folderName ?? '',
                    busy: false,
                    error: null,
                  })
                } else if (result.opened) {
                  setReady(true)
                }
              })
              .catch((error: unknown) => {
                setSetup((current) => ({
                  serverUrl: current?.serverUrl ?? 'http://127.0.0.1:8000',
                  error: hostOperationErrorMessage(error),
                }))
              })
            return
          }
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
        const entry = state.connections.find((candidate) => candidate.id === activeId) ?? null
        // The local connection stores no URL by design (its port is per
        // process), so "has no URL" must not be read as "unconfigured" — that
        // reading sent anyone who quit while on the local connection back to
        // the first-run screen on every launch, against ADR-0018's "local
        // libraries just work". Only a remote entry without a URL is broken.
        if (!activeId || !entry || (entry.kind === 'remote' && !entry.serverUrl)) {
          setSetup({ serverUrl: 'http://127.0.0.1:8000', error: null })
          return
        }
        try {
          // Activation does the whole job for either kind: it starts the
          // sidecar for local, and for remote it probes reachability before
          // committing — no separate verify step here.
          await activateConnection(activeId)
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
              serverUrl: entry.serverUrl ?? 'http://127.0.0.1:8000',
              error:
                entry.kind === 'local'
                  ? hostOperationErrorMessage(error)
                  : error instanceof Error && error.message === INCOMPATIBLE_SERVER_ERROR
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
      // Activation probes reachability itself before committing, so a dead or
      // incompatible address throws here and nothing below runs.
      await activateConnection(connection.id)
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

  // Names the picked folder, then creates the library and lets the app in. The
  // shell has been holding the folder since the pick, so cancelling costs
  // nothing and simply returns to setup.
  const namingDialog = naming && (
    <NewLibraryDialog
      folderName={naming.folderName}
      busy={naming.busy}
      error={naming.error}
      onCancel={() => setNaming(null)}
      onConfirm={(name) => {
        setNaming({ ...naming, busy: true, error: null })
        void confirmPickedLibrary(naming.token, name)
          .then(() => {
            setNaming(null)
            setReady(true)
          })
          .catch((error: unknown) => {
            setNaming((current) =>
              current ? { ...current, busy: false, error: hostOperationErrorMessage(error) } : null,
            )
          })
      }}
    />
  )

  // Keyed on the active connection: a switch remounts the whole scope, so the
  // previous server's cache and any request still in flight against it are
  // discarded rather than left to resolve into the new connection's cache
  // (plan 3 §7.1 — library ids are per-server and not globally unique).
  if (ready) return <QueryScope key={activeConnectionId ?? 'initial'}>{children}</QueryScope>
  if (!setup)
    return (
      <>
        <div className="app-loading">Loading desktop settings…</div>
        {namingDialog}
      </>
    )

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
      {namingDialog}
    </main>
  )
}
