import { useModalDialog } from './useModalDialog'
import { useEffect, useId, useState } from 'react'
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
  pending = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  title: string
  label: string
  initial?: string
  confirmLabel?: string
  pending?: boolean
  error?: string | null
  onCancel: () => void
  onConfirm: (value: string) => void
}) {
  const [value, setValue] = useState(initial)
  const trimmed = value.trim()
  const inputId = useId()

  const { ref: dialogRef, close: closeDialog } = useModalDialog(onCancel, pending)

  useEffect(() => {
    if (error) dialogRef.current?.querySelector('input')?.focus()
  }, [error, dialogRef])

  return createPortal(
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button
            className="modal__close"
            onClick={closeDialog}
            disabled={pending}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <label className="field-label" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          className="edit"
          value={value}
          autoFocus
          spellCheck={false}
          disabled={pending}
          aria-invalid={Boolean(error)}
          onFocus={(e) => e.target.select()}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || !trimmed || pending) return
            e.preventDefault()
            onConfirm(trimmed)
          }}
        />

        {error && (
          <div role="alert" className="modal__error">
            {error}
          </div>
        )}

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={closeDialog} disabled={pending}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            disabled={pending || !trimmed}
            onClick={() => onConfirm(trimmed)}
          >
            {pending ? 'Saving…' : confirmLabel}
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
  const { ref: dialogRef, close: closeDialog } = useModalDialog(onCancel, pending)

  return createPortal(
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div
        className="modal modal--confirm"
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal__head">
          <h2>{title}</h2>
          <button
            className="modal__close"
            onClick={closeDialog}
            disabled={pending}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="modal__preview">{body}</div>

        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button className="btn" onClick={closeDialog} disabled={pending}>
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
