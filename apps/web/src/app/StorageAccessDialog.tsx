import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import type { StorageAccess } from './StorageAccessNotice'
import {
  ACCESS_REQUEST,
  ACCESS_WAITING,
  NO_SAVED_LOGIN,
  useStorageAuthorization,
} from './useStorageAuthorization'
import { useModalDialog } from './useModalDialog'

/** Show an actionable request once; dismissing keeps a small way to reopen it. */
export function StorageAccessDialog(props: {
  access: StorageAccess
  authorize: () => Promise<unknown>
  onAuthorized: () => void
}) {
  const [open, setOpen] = useState(true)
  return open ? (
    <AccessDialog {...props} onClose={() => setOpen(false)} />
  ) : (
    <button className="btn btn--sm" onClick={() => setOpen(true)}>
      Network Share Access…
    </button>
  )
}

function AccessDialog({
  access,
  authorize,
  onAuthorized,
  onClose,
}: {
  access: StorageAccess
  authorize: () => Promise<unknown>
  onAuthorized: () => void
  onClose: () => void
}) {
  const { waiting, error, allow } = useStorageAuthorization(authorize, () => {
    onAuthorized()
    onClose()
  })
  const title = useId()
  const { ref, close } = useModalDialog(onClose, waiting)
  const login = access === 'login'
  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="modal modal--confirm storage-access-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={title}>Network Share Access</h2>
        <p className="modal__preview" role={login ? 'alert' : undefined}>
          {login ? NO_SAVED_LOGIN : waiting ? ACCESS_WAITING : ACCESS_REQUEST}
        </p>
        {error && (
          <p className="modal__error" role="alert">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={close} disabled={waiting}>
            {login ? 'Close' : 'Cancel'}
          </button>
          {!login && (
            <button
              className="btn btn--primary"
              disabled={waiting}
              onClick={() => void allow()}
              autoFocus
            >
              {waiting ? 'Waiting for macOS…' : 'Allow Access…'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
