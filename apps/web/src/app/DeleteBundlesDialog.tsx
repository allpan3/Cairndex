import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

interface DeleteBundlesDialogProps {
  /** How many bundles will be deleted (≥ 1). */
  count: number
  pending: boolean
  /** True when the targets are confirmed bundles, whose files fall back into the
   * Unbundled view rather than being dropped from the library. */
  filesReturnToUnbundled?: boolean
  /** Whether this library may delete files at all (ADR-0013's two gates). */
  writeMode?: boolean
  onCancel: () => void
  /** `deleteFiles` sends the files to the trash as well as removing the bundle. */
  onConfirm: (deleteFiles: boolean) => void
}

/**
 * Confirm deleting one or more bundles.
 *
 * Deletion is metadata-only by default: the bundle rows go away and the files
 * stay on disk. "Also delete contained files" additionally sends them to the
 * library's trash — never an unlink, so it is undoable and they remain listed
 * until the trash is emptied. It defaults off, and is unavailable entirely on a
 * library without write mode, where the server would refuse it anyway.
 */
export function DeleteBundlesDialog({
  count,
  pending,
  filesReturnToUnbundled = false,
  writeMode = false,
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

        {/* What happens to the files is stated once, below, because the checkbox
            changes the answer — saying "the files stay on disk" up here would be
            a promise the ticked box then breaks. */}
        <div className="modal__preview">
          Delete {noun}? This removes the Cairndex metadata.
          {filesReturnToUnbundled && !deleteFiles
            ? ' Their files fall back into Unbundled, so you can re-bundle them.'
            : ''}
        </div>

        {writeMode ? (
          <>
            <label className="check-row">
              <input
                type="checkbox"
                checked={deleteFiles}
                onChange={(e) => setDeleteFiles(e.target.checked)}
              />
              Also delete contained files
            </label>
            <div className="modal__preview">
              {deleteFiles
                ? 'The files move to this library’s Trash, where you can put them back until you empty it.'
                : 'The files stay where they are on disk.'}
            </div>
          </>
        ) : (
          // No checkbox without write mode — the server would refuse it — but the
          // question "what happens to my files?" still needs an answer.
          <div className="modal__preview">The files stay where they are on disk.</div>
        )}

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
