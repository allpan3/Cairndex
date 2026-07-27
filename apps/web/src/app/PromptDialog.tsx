import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Ask for one line of text, and confirm a decision — the two shapes this app
 * had been reaching for `window.prompt`/`window.confirm` to get.
 *
 * Those do not work in the desktop shell at all: Tauri's webview does not
 * implement the JavaScript dialogs, so a prompt returns null and the caller
 * silently does nothing. That is why renaming a tag "did not work" and deleting
 * one "gave no confirmation" there while both behaved in the browser (owner,
 * 2026-07-27). Anything that needs an answer from the user has to render it.
 */

export function PromptDialog({
  title,
  label,
  initial = '',
  confirmLabel = 'Save',
  onCancel,
  onConfirm,
}: {
  title: string
  label: string
  initial?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const trimmed = value.trim()

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>

        <label className="field-label" htmlFor="prompt-value">
          {label}
        </label>
        <input
          id="prompt-value"
          className="edit"
          value={value}
          autoFocus
          spellCheck={false}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !trimmed) return
            e.preventDefault()
            onConfirm(trimmed)
          }}
        />

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={!trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'Delete',
  danger = true,
  pending = false,
  onCancel,
  onConfirm,
}: {
  title: string
  body: React.ReactNode
  confirmLabel?: string
  danger?: boolean
  pending?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCancel()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
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
          <button className="modal__close" onClick={onCancel} aria-label="Close">
            ×
          </button>
        </div>

        <div className="modal__preview">{body}</div>

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
            disabled={pending}
            autoFocus
          >
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
