import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getHostPlatform, hostOperationErrorMessage, normalizeHostServerUrl } from '../platform'
import {
  activateConnection,
  addRemoteConnection,
  cancelActivation,
  ensureLocalConnection,
  getActivation,
  getConnections,
  localConnection,
  subscribeConnections,
} from './connections'

// Keeps server choice reachable during normal browsing, startup and library recovery
export function ConnectionControls({ onConnected }: { onConnected?: () => void }) {
  const state = useSyncExternalStore(subscribeConnections, getConnections)
  const attempt = useSyncExternalStore(subscribeConnections, getActivation)
  const desktop = getHostPlatform().kind === 'desktop'
  const active = state.connections.find((item) => item.id === state.activeConnectionId)
  const choices = state.connections.some((item) => item.kind === 'local')
    ? state.connections
    : [localConnection(), ...state.connections]
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    if (open) dialog.current?.showModal()
    else dialog.current?.close()
  }, [open])

  // Await activation so a failed or cancelled target keeps both the old workspace and chooser
  async function connect(id: string) {
    setError(null)
    setBusy(true)
    try {
      if (id === 'local') await ensureLocalConnection()
      await activateConnection(id)
      onConnected?.()
      setOpen(false)
    } catch (reason) {
      setError(hostOperationErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  // Browser navigation retains the server's same-origin cookie and path boundary
  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (busy || attempt.id) return
    setError(null)
    setBusy(true)
    try {
      if (!desktop) {
        const target = new URL(url)
        if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
          throw new Error('Enter an HTTP or HTTPS server address without credentials.')
        window.location.assign(target.href)
        return
      }
      const address = await normalizeHostServerUrl(url)
      const connection = await addRemoteConnection(address)
      await connect(connection.id)
    } catch (reason) {
      setError(hostOperationErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  const pending = busy || attempt.id !== null
  return (
    <>
      <header className="connection-bar">
        <span title={active?.serverUrl ?? undefined}>
          Server:{' '}
          <strong>{desktop ? (active?.label ?? 'Choose a server') : window.location.host}</strong>
        </span>
        <button className="btn" onClick={() => setOpen(true)}>
          Servers…
        </button>
        {desktop && active && (
          <button className="btn" disabled={pending} onClick={() => void connect(active.id)}>
            Reconnect
          </button>
        )}
        {attempt.id && (
          <span role="status">{attempt.cancellable ? 'Connecting…' : 'Finishing connection…'}</span>
        )}
        {attempt.cancellable && (
          <button className="btn" onClick={cancelActivation}>
            Cancel connection
          </button>
        )}
        {!open && !onConnected && (error || attempt.error) && (
          <span role="alert">{error || attempt.error}</span>
        )}
      </header>
      <dialog
        ref={dialog}
        aria-labelledby="connection-title"
        className="modal connection-dialog"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <div className="modal__head">
          <h2 id="connection-title">Servers</h2>
          <button
            className="modal__close"
            aria-label="Close servers"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>
        {desktop ? (
          <div className="connection-choices">
            {choices.map((item) => (
              <button
                key={item.id}
                className="btn"
                disabled={pending}
                aria-current={item.id === active?.id ? 'true' : undefined}
                onClick={() => void connect(item.id)}
              >
                <strong>{item.label}</strong>
                <span>
                  {item.kind === 'local' ? 'Libraries opened on this computer' : item.serverUrl}
                </span>
                <small>
                  {item.id === active?.id
                    ? 'Selected server · reconnect'
                    : 'Connect and choose a library'}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <p>Open another server in this tab. Each server keeps its own libraries and sign-in.</p>
        )}
        <form className="lib-add" onSubmit={(event) => void add(event)}>
          <label className="field-label" htmlFor="connection-url">
            {desktop ? 'Add a server' : 'Server address'}
          </label>
          <div className="lib-add__row">
            <input
              id="connection-url"
              className="edit"
              type="url"
              required
              value={url}
              placeholder="https://server.example"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(event) => setUrl(event.target.value)}
            />
            <button className="btn btn--primary" disabled={pending}>
              {pending ? 'Connecting…' : desktop ? 'Add and connect' : 'Open server'}
            </button>
          </div>
          {attempt.cancellable && (
            <button type="button" className="btn" onClick={cancelActivation}>
              Cancel connection
            </button>
          )}
          {(error || attempt.error) && <p role="alert">{error || attempt.error}</p>}
        </form>
      </dialog>
    </>
  )
}
