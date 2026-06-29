import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface DeleteBundlesDialogProps {
  /** How many bundles will be deleted (≥ 1). */
  count: number
  pending: boolean
  onCancel: () => void
  /** `deleteFiles` reflects the checkbox; filesystem deletion is not wired yet. */
  onConfirm: (deleteFiles: boolean) => void
}

/**
 * Confirm deleting one or more bundles. Deletion is metadata-only today —
 * the bundle rows go away but the files on disk are kept (AGENTS.md §3). The
 * "Also delete contained files" checkbox is the forward-looking UI for a future
 * write-enabled milestone; it defaults off and, until file deletion is enabled,
 * does not remove anything from disk.
 */
export function DeleteBundlesDialog({
  count,
  pending,
  onCancel,
  onConfirm,
}: DeleteBundlesDialogProps) {
  const [deleteFiles, setDeleteFiles] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const noun = count > 1 ? `these ${count} bundles` : 'this bundle'

  return createPortal(
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Delete bundle"
      >
        <div className="modal__head">
          <h2>{count > 1 ? `Delete ${count} bundles` : 'Delete Bundle'}</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Cancel">
            ×
          </button>
        </div>

        <div className="modal__preview">
          Delete {noun}? This removes the Cairndex metadata — by default the files stay on disk.
        </div>

        <label className="check-row">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
          />
          Also delete contained files
        </label>
        <div className="modal__preview">
          Deleting files from disk isn’t enabled yet — for now the files are always kept.
        </div>

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            onClick={() => onConfirm(deleteFiles)}
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
