import { useState } from 'react'

/** Why the server cannot read a network share's saved login. */
export type StorageAccess = 'authorization' | 'login'

/**
 * The owner's way past a network share whose saved login the server cannot read.
 *
 * For `authorization`, Allow Access asks macOS, on the server's screen, to let the
 * server use the login. macOS asks for the Mac's login password; Always Allow keeps
 * background work from needing the request again. For `login`, no saved login
 * exists, so only Finder can fix it. `showMessage` is off where the surrounding
 * error already explains the problem.
 */
export function StorageAccessNotice({
  access,
  authorize,
  onAuthorized,
  showMessage = true,
}: {
  access: StorageAccess
  authorize: () => Promise<unknown>
  onAuthorized?: () => void
  showMessage?: boolean
}) {
  const [waiting, setWaiting] = useState(false)
  const [error, setError] = useState('')
  async function allow() {
    setWaiting(true)
    setError('')
    try {
      await authorize()
      onAuthorized?.()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setWaiting(false)
    }
  }
  if (access === 'login')
    return showMessage ? (
      <p className="storage-access" role="alert">
        No saved login matches this network share. In Finder, connect to the share and choose to
        remember the password in your keychain. Then retry.
      </p>
    ) : null
  return (
    <div className="storage-access" role={showMessage ? 'alert' : undefined}>
      {showMessage && (
        <p>Cairndex needs your permission to use the login saved for this network share.</p>
      )}
      {waiting && (
        <p role="status">
          macOS asks for your Mac login password. Type it, then choose Always Allow.
        </p>
      )}
      {error && <p className="modal__error">{error}</p>}
      <button className="btn btn--primary" disabled={waiting} onClick={() => void allow()}>
        {waiting ? 'Waiting for macOS…' : 'Allow Access…'}
      </button>
    </div>
  )
}
