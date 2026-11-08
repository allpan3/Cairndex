import {
  ACCESS_REQUEST,
  ACCESS_WAITING,
  NO_SAVED_LOGIN,
  useStorageAuthorization,
} from './useStorageAuthorization'

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
  const { waiting, error, allow } = useStorageAuthorization(authorize, onAuthorized)
  if (access === 'login')
    return showMessage ? (
      <p className="storage-access" role="alert">
        {NO_SAVED_LOGIN}
      </p>
    ) : null
  return (
    <div className="storage-access" role={showMessage ? 'alert' : undefined}>
      {showMessage && <p>{ACCESS_REQUEST}</p>}
      {waiting && <p role="status">{ACCESS_WAITING}</p>}
      {error && <p className="modal__error">{error}</p>}
      <button className="btn btn--primary" disabled={waiting} onClick={() => void allow()}>
        {waiting ? 'Waiting for macOS…' : 'Allow Access…'}
      </button>
    </div>
  )
}
