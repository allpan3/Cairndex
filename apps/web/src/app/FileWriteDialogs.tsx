import { useState } from 'react'

/**
 * The collision prompt (ADR-0013 §3.3).
 *
 * **Replace is deliberately absent.** The ADR defines it as trash-then-write —
 * the existing file moves to the library's trash before the incoming one takes
 * the path — so that it is always recoverable. The trash lands in a later
 * slice; offering the word before then would promise something that could not
 * be undone. Keep both is available now because it loses nothing.
 */
export function ConflictDialog({
  name,
  onKeepBoth,
  onCancel,
  busy,
}: {
  name: string
  onKeepBoth: () => void
  onCancel: () => void
  busy: boolean
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--narrow"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Name already in use"
      >
        <div className="modal__head">
          <h2>“{name}” already exists here</h2>
        </div>
        <p className="lib-add__hint">
          Nothing has been changed. Keeping both adds a number to the new name, like “{name} (2)”.
        </p>
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--primary" onClick={onKeepBoth} disabled={busy}>
            Keep both
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The inline name editor used by both rename and New Folder.
 *
 * Enter commits, Escape cancels, and blur commits — the file-manager
 * convention, where clicking away is an ordinary way to finish. Keystrokes stop
 * propagating so the list's own shortcuts (F2, Enter, arrow keys) do not fire
 * while a name is being typed.
 */
export function NameEditor({
  initial,
  onSubmit,
  onCancel,
  label,
}: {
  initial: string
  onSubmit: (name: string) => void
  onCancel: () => void
  label: string
}) {
  const [value, setValue] = useState(initial)
  // Guards the blur handler: committing on Enter also blurs, which would
  // otherwise submit the same name twice.
  const [settled, setSettled] = useState(false)

  const commit = () => {
    if (settled) return
    setSettled(true)
    onSubmit(value)
  }

  return (
    <input
      className="edit file-row__rename"
      value={value}
      aria-label={label}
      autoFocus
      spellCheck={false}
      onFocus={(event) => {
        // Select the stem, not the extension: renaming a file almost never
        // means renaming its type.
        const dot = value.lastIndexOf('.')
        event.target.setSelectionRange(0, dot > 0 ? dot : value.length)
      }}
      onChange={(event) => setValue(event.target.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          setSettled(true)
          onCancel()
        }
      }}
    />
  )
}
