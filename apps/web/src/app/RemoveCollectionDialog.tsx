import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { CollectionRead } from '../api/client'

interface RemoveCollectionDialogProps {
  /** The collection(s) to delete (one from the sidebar/single card, several from
   * a multi-selection in the main browser). */
  collections: CollectionRead[]
  /** Whether any target has subcollections (controls the cascade checkbox). */
  hasChildren: boolean
  pending: boolean
  onCancel: () => void
  /** `cascade` is true to also remove subcollections, false to float them up. */
  onConfirm: (cascade: boolean) => void
}

/**
 * Confirm deleting one or more collections. Deletion is metadata-only — bundles
 * and files are always kept. When any target has subcollections the owner chooses
 * (checked by default) whether to delete them too or float them to the top level.
 */
export function RemoveCollectionDialog({
  collections,
  hasChildren,
  pending,
  onCancel,
  onConfirm,
}: RemoveCollectionDialogProps) {
  const [cascade, setCascade] = useState(true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const count = collections.length
  const title = count > 1 ? `Delete ${count} Collections` : 'Delete Collection'
  const target = count > 1 ? `these ${count} collections` : `“${collections[0]?.name ?? ''}”`

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Cancel">
            ×
          </button>
        </div>

        <div className="modal__preview">
          Delete {target}? The bundles and files inside {count > 1 ? 'them' : 'it'} are kept — only
          the collection{count > 1 ? 's are' : ' is'} deleted.
        </div>

        {hasChildren && (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />
              Also delete subcollections
            </label>
            <div className="modal__preview">
              {cascade
                ? 'Subcollections (and any nested below them) will be deleted too.'
                : 'Subcollections will move to the top level instead of being deleted.'}
            </div>
          </>
        )}

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={() => onConfirm(hasChildren ? cascade : false)}
            disabled={pending}
          >
            {pending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
