import { useEffect, useState } from 'react'

import { fetchHealth, setApiBaseUrl } from '../api/client'
import {
  isDesktopHost,
  listenDesktopClose,
  loadDesktopServerUrl,
  normalizeDesktopServerUrl,
  saveDesktopServerUrl,
} from './runtime'

interface DesktopBootstrapProps {
  children: React.ReactNode
}

interface SetupState {
  serverUrl: string
  error: string | null
}

// Verifies that a normalized server URL reaches a live Cairndex backend
async function verifyServer(serverUrl: string): Promise<void> {
  setApiBaseUrl(serverUrl)
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 5000)
  try {
    await fetchHealth(controller.signal)
  } finally {
    window.clearTimeout(timeout)
  }
}

// Gates the shared SPA on first-run desktop server configuration
export function DesktopBootstrap({ children }: DesktopBootstrapProps) {
  const desktop = isDesktopHost()
  const [ready, setReady] = useState(!desktop)
  const [setup, setSetup] = useState<SetupState | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!desktop) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listenDesktopClose()
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [desktop])

  useEffect(() => {
    if (!desktop) return
    let active = true
    void loadDesktopServerUrl()
      .then(async (stored) => {
        if (!active) return
        if (!stored) {
          setSetup({ serverUrl: 'http://127.0.0.1:8000', error: null })
          return
        }
        try {
          await verifyServer(stored)
          if (active) setReady(true)
        } catch {
          if (active) {
            setSetup({
              serverUrl: stored,
              error: 'Cairndex did not respond at this address. Check that the server is running.',
            })
          }
        }
      })
      .catch(() => {
        if (active) {
          setSetup({
            serverUrl: 'http://127.0.0.1:8000',
            error: 'The desktop settings store could not be opened.',
          })
        }
      })
    return () => {
      active = false
    }
  }, [desktop])

  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!setup || saving) return
    setSaving(true)
    setSetup({ ...setup, error: null })
    try {
      const normalized = await normalizeDesktopServerUrl(setup.serverUrl)
      await verifyServer(normalized)
      await saveDesktopServerUrl(normalized)
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

  if (ready) return children
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
