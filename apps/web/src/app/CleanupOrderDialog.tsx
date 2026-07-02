import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

export interface CleanupChoice {
  /** Opaque value handed back to the caller on confirm (it decides the meaning —
   * e.g. `asc`/`desc` for collections, `title:desc` for bundles). */
  key: string
  label: string
}

interface CleanupOrderDialogProps {
  title: string
  /** One-line explanation of what the cleanup rewrites. */
  description: string
  choices: CleanupChoice[]
  pending: boolean
  onCancel: () => void
  onConfirm: (key: string) => void
}

/**
 * Shared confirm dialog for "Clean up by…": pick a sort key, confirm, and the
 * caller rewrites the persisted manual order to match. Used for both collections
 * (Title A–Z / Z–A) and bundles (the toolbar sorts × asc/desc). Overwriting a
 * hand-tuned manual order is destructive-ish, so it always confirms first.
 */
export function CleanupOrderDialog({
  title,
  description,
  choices,
  pending,
  onCancel,
  onConfirm,
}: CleanupOrderDialogProps) {
  const [choice, setChoice] = useState(choices[0]?.key ?? '')

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
        aria-label={title}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button className="modal__close" onClick={onCancel} aria-label="Cancel">
            ×
          </button>
        </div>

        <div className="modal__preview">{description}</div>

        <label className="check-row">
          Order by
          <select
            className="edit"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
            aria-label="Clean-up order"
          >
            {choices.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={() => onConfirm(choice)} disabled={pending}>
            {pending ? 'Cleaning up…' : 'Clean up'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
