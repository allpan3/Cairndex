import { useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { StorageAccessNotice, type StorageAccess } from './StorageAccessNotice'
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
  const [waiting, setWaiting] = useState(false)
  const title = useId()
  const { ref, close } = useModalDialog(onClose, waiting)
  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={title}>Network Share Access</h2>
        <StorageAccessNotice
          access={access}
          authorize={async () => {
            setWaiting(true)
            try {
              await authorize()
            } finally {
              setWaiting(false)
            }
          }}
          onAuthorized={() => {
            onAuthorized()
            onClose()
          }}
        />
        <div className="modal__actions">
          <button className="btn" onClick={close} disabled={waiting}>
            Cancel
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
