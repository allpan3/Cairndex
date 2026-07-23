import { useState } from 'react'

/**
 * The collision prompt (ADR-0013 §3.3) — Finder's and Eagle's three answers.
 *
 * **Replace is not an overwrite**, and the dialog says so rather than leaving
 * the owner to hope: the existing file is deleted to the library's trash first,
 * so the choice stays reversible until the trash is emptied. That is the whole
 * reason the trash was built before this button was offered.
 */
export function ConflictDialog({
  name,
  onKeepBoth,
  onReplace,
  onCancel,
  busy,
}: {
  name: string
  onKeepBoth: () => void
  onReplace: () => void
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
          Nothing has been changed yet. <strong>Keep both</strong> adds a number to the new name,
          like “{name} (2)”. <strong>Replace</strong> moves the existing file to this library’s
          trash first, so you can still get it back.
        </p>
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn" onClick={onReplace} disabled={busy}>
            Replace
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
 * The delete confirmation (ADR-0013 §3.2).
 *
 * Says *where the files go*, not "are you sure?" — the honest thing to confirm
 * is that this is a move into the library's trash, recoverable until it is
 * emptied, rather than an unlink. Linked files get a count, because deleting
 * something a bundle is built on is the case worth a second look.
 */
export function DeleteDialog({
  paths,
  linkedCount,
  onConfirm,
  onCancel,
  busy,
}: {
  paths: string[]
  linkedCount: number
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  const single = paths.length === 1 ? (paths[0] as string).split('/').pop() : null

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--narrow"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Move to Trash"
      >
        <div className="modal__head">
          <h2>
            {single ? `Move “${single}” to the trash?` : `Move ${paths.length} items to the trash?`}
          </h2>
        </div>
        <p className="lib-add__hint">
          They stay inside this library, in its trash, and can be put back until you empty it.
          {linkedCount > 0 && (
            <>
              {' '}
              {linkedCount === 1
                ? 'One of them is part of a bundle; it stays in that bundle and comes back with it if you restore.'
                : `${linkedCount} of them are part of bundles; they stay in those bundles and come back with them if you restore.`}
            </>
          )}
        </p>
        {paths.length > 1 && (
          <ul className="trash-preview">
            {paths.slice(0, 8).map((path) => (
              <li key={path}>{path.split('/').pop()}</li>
            ))}
            {paths.length > 8 && <li>…and {paths.length - 8} more</li>}
          </ul>
        )}
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={busy}>
            Move to Trash
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
