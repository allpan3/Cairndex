import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { hostOperationErrorMessage, normalizeHostServerUrl } from '../platform'
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

/**
 * File ▸ Servers…: switch between This Computer and the saved servers, or add
 * one. It is a menu item rather than a bar above the app, as in v0.2.1, and the
 * menu reaches it from first run, a lock screen and library recovery alike.
 */
export function ServersDialog({
  open,
  onClose,
  onConnected,
}: {
  open: boolean
  onClose: () => void
  onConnected: () => void
}) {
  const state = useSyncExternalStore(subscribeConnections, getConnections)
  const attempt = useSyncExternalStore(subscribeConnections, getActivation)
  const active = state.connections.find((item) => item.id === state.activeConnectionId)
  const choices = state.connections.some((item) => item.kind === 'local')
    ? state.connections
    : [localConnection(), ...state.connections]
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
      onConnected()
      onClose()
    } catch (reason) {
      setError(hostOperationErrorMessage(reason))
    } finally {
      setBusy(false)
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault()
    if (busy || attempt.id) return
    setError(null)
    setBusy(true)
    try {
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
    <dialog
      ref={dialog}
      aria-labelledby="connection-title"
      className="modal connection-dialog"
      // State closes the dialog, not Escape: a native close queues a `close`
      // event, which could arrive after Servers… had already reopened it
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <div className="modal__head">
        <h2 id="connection-title">Servers</h2>
        <button className="modal__close" aria-label="Close servers" onClick={onClose}>
          ×
        </button>
      </div>
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
      <form className="lib-add" onSubmit={(event) => void add(event)}>
        <label className="field-label" htmlFor="connection-url">
          Add a server
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
            {pending ? 'Connecting…' : 'Add and connect'}
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
  )
}
