import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

import type { CollectionRead } from '../api/client'

interface RemoveCollectionDialogProps {
  collection: CollectionRead
  /** Whether the collection has any subcollections (controls the checkbox). */
  hasChildren: boolean
  pending: boolean
  onCancel: () => void
  /** `cascade` is true to also remove subcollections, false to float them up. */
  onConfirm: (cascade: boolean) => void
}

/**
 * Confirm removing a collection. Removal is metadata-only — bundles and files
 * are always kept. When the collection has subcollections the owner chooses
 * (checked by default) whether to remove them too or float them to the top
 * level.
 */
export function RemoveCollectionDialog({
  collection,
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

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Remove collection"
      >
        <div className="modal__head">
          <h2>Remove Collection</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Cancel">
            ×
          </button>
        </div>

        <div className="modal__preview">
          Remove “{collection.name}”? The bundles and files inside it are kept — only the collection
          is removed.
        </div>

        {hasChildren && (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={cascade}
                onChange={(e) => setCascade(e.target.checked)}
              />
              Also remove subcollections
            </label>
            <div className="modal__preview">
              {cascade
                ? 'Subcollections (and any nested below them) will be removed too.'
                : 'Subcollections will move to the top level instead of being removed.'}
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
            {pending ? 'Removing…' : 'Remove'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
