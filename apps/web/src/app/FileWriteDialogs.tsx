import { useEffect, useRef, useState } from 'react'

import { useBundleFiles, useFileBrowser, useFileOperations } from '../api/hooks'
import { focusRenameInput } from './renameSelection'

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
  onSkip,
  onCancel,
  busy,
}: {
  name: string
  onKeepBoth: () => void
  onReplace: () => void
  /**
   * Leave this one alone and carry on with the rest. Offered only where there
   * *is* a rest — a batch of files — because for a single rename or move it
   * would mean exactly what Cancel already means.
   */
  onSkip?: () => void
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
          {onSkip ? (
            <>
              {' '}
              <strong>Skip</strong> leaves this one out and carries on with the rest, while{' '}
              <strong>Cancel</strong> stops here and does not copy what is left.
            </>
          ) : null}
        </p>
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          {onSkip && (
            <button type="button" className="btn" onClick={onSkip} disabled={busy}>
              Skip
            </button>
          )}
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
 * The destination picker for Move to… (ADR-0013 §7, plan 4 W3), and for any
 * other operation that has to land somewhere the owner chose.
 *
 * Navigates the library's own directory tree one level at a time — the same
 * listing the File Browser shows — rather than a free-text path, so the
 * destination is always a real, in-root directory the owner can see. The
 * folders being moved are removed from the list: a folder cannot be moved into
 * itself, and offering to descend into one would only lead to that dead end.
 * Choosing the directory an item already sits in is harmless — the server
 * reports it moved nothing.
 *
 * `startIn` opens the picker already inside a folder. Callers use it to make the
 * likely answer the default one — a drop onto a bundle starts where the bundle's
 * own files live — while leaving every other folder one click away.
 */
/** An operation failure as one readable line. */
function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : 'That could not be done.'
}

export function DirectoryPicker({
  moving = [],
  onChoose,
  onCancel,
  busy,
  startIn = '',
  heading,
  confirmLabel,
  allowNewFolder = false,
}: {
  /** Library-relative paths being moved, excluded from the tree. */
  moving?: string[]
  onChoose: (destDir: string) => void
  onCancel: () => void
  busy: boolean
  /** Library-relative directory to open in; '' is the library root. */
  startIn?: string
  /** Dialog title; defaults to the Move to… wording. */
  heading?: string
  /** Confirm-button label, given the chosen directory's display name. */
  confirmLabel?: (where: string) => string
  /**
   * Offers New Folder inside the picker. Opt-in rather than always on: choosing
   * where to *add* a file is often the moment you realise the folder does not
   * exist yet, while choosing where to move something usually is not — and this
   * dialog is shared with Move to…, which should not change silently.
   */
  allowNewFolder?: boolean
}) {
  const [here, setHere] = useState(startIn)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [folderName, setFolderName] = useState('')
  const { mkdir } = useFileOperations()
  const { data, isLoading } = useFileBrowser(here || null)
  const excluded = new Set(moving)
  const subdirs = (data?.entries ?? [])
    .filter((entry) => entry.kind === 'directory' && !excluded.has(entry.relative_path))
    .sort((a, b) => a.name.localeCompare(b.name))
  const crumbs = here ? here.split('/') : []
  const count = moving.length

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal modal--narrow"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={heading ?? 'Move to'}
      >
        <div className="modal__head">
          <h2>{heading ?? (count === 1 ? 'Move to…' : `Move ${count} items to…`)}</h2>
        </div>
        <nav className="dir-picker__crumbs" aria-label="Destination folder">
          <button
            type="button"
            className="dir-picker__crumb"
            onClick={() => setHere('')}
            disabled={busy || here === ''}
          >
            Library
          </button>
          {crumbs.map((segment, index) => (
            <span key={crumbs.slice(0, index + 1).join('/')}>
              <span className="dir-picker__sep"> / </span>
              <button
                type="button"
                className="dir-picker__crumb"
                onClick={() => setHere(crumbs.slice(0, index + 1).join('/'))}
                disabled={busy || index === crumbs.length - 1}
              >
                {segment}
              </button>
            </span>
          ))}
        </nav>
        {allowNewFolder && (
          <div className="dir-picker__actions">
            {creatingFolder ? (
              // Deliberately not `NameEditor`, which is the *inline list* editor:
              // it commits on blur, which is right when clicking away in a file
              // list ends an edit and wrong in a dialog, where clicking the
              // confirm button would create the folder and import into its
              // parent in one gesture. A form instead — Enter submits, and the
              // buttons say what will happen (owner report, 2026-08-23: "there's
              // only this text box").
              <form
                className="dir-picker__new"
                onSubmit={(event) => {
                  event.preventDefault()
                  const trimmed = folderName.trim()
                  if (!trimmed) return
                  const path = here ? `${here}/${trimmed}` : trimmed
                  // Step into it on success: the folder was created to be the
                  // destination, so leaving the picker outside it would make
                  // every caller navigate in by hand.
                  mkdir.mutate(path, {
                    onSuccess: () => {
                      setHere(path)
                      setCreatingFolder(false)
                      setFolderName('')
                    },
                  })
                }}
              >
                <input
                  className="edit"
                  value={folderName}
                  aria-label="New folder name"
                  placeholder="Folder name"
                  spellCheck={false}
                  autoFocus
                  onChange={(event) => setFolderName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                      event.preventDefault()
                      setCreatingFolder(false)
                      setFolderName('')
                    }
                  }}
                />
                <button
                  type="submit"
                  className="btn btn--sm btn--primary"
                  disabled={folderName.trim() === '' || mkdir.isPending}
                >
                  {mkdir.isPending ? 'Creating…' : 'Create'}
                </button>
                {/* An icon, not a second "Cancel": the dialog already has one
                    at the bottom meaning "don't add the files at all", and two
                    identically-named buttons are ambiguous to read and worse to
                    hear. */}
                <button
                  type="button"
                  className="btn btn--sm btn--compact"
                  onClick={() => {
                    setCreatingFolder(false)
                    setFolderName('')
                  }}
                  disabled={mkdir.isPending}
                  aria-label="Cancel new folder"
                  title="Cancel new folder"
                >
                  ✕
                </button>
              </form>
            ) : (
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => setCreatingFolder(true)}
                disabled={busy || mkdir.isPending}
              >
                New Folder
              </button>
            )}
            {mkdir.isError && (
              <span className="dir-picker__error" role="alert">
                {messageOf(mkdir.error)}
              </span>
            )}
          </div>
        )}
        <ul className="dir-picker__list">
          {isLoading ? (
            <li className="dir-picker__empty">Loading…</li>
          ) : subdirs.length === 0 ? (
            <li className="dir-picker__empty">No subfolders here.</li>
          ) : (
            subdirs.map((entry) => (
              <li key={entry.relative_path}>
                <button
                  type="button"
                  className="dir-picker__row"
                  onClick={() => setHere(entry.relative_path)}
                  disabled={busy}
                >
                  {entry.name}
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="modal__actions">
          <span className="toolbar__spacer" />
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => onChoose(here)}
            disabled={busy}
          >
            {confirmLabel
              ? confirmLabel(here ? (here.split('/').pop() as string) : 'Library root')
              : here
                ? `Move here`
                : 'Move to Library root'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Where files dropped onto a bundle should land on disk.
 *
 * A drop used to copy straight into the library root, which is almost never
 * where the bundle's own files live — so the new file arrived correctly linked
 * but filed in the wrong folder, and putting it right meant a second, manual
 * move (owner report, 2026-07-30). The picker opens in the folder the bundle's
 * first file sits in, which is the answer nearly every time, and any other
 * folder is still one click away.
 *
 * Rendered only once the bundle's files are known, so the picker never opens at
 * the root and then jumps: `startIn` is read once, when the picker mounts.
 */
export function BundleDropDestination({
  bundleId,
  fileCount,
  onChoose,
  onCancel,
  busy,
}: {
  bundleId: string
  /** How many dropped files this destination is for, for the heading. */
  fileCount: number
  onChoose: (destDir: string) => void
  onCancel: () => void
  busy: boolean
}) {
  const { data, isLoading } = useBundleFiles(bundleId)
  if (isLoading) return null
  const first = data?.[0]?.relative_path ?? ''
  const slash = first.lastIndexOf('/')
  return (
    <DirectoryPicker
      startIn={slash > 0 ? first.slice(0, slash) : ''}
      heading={fileCount === 1 ? 'Copy the file into…' : `Copy ${fileCount} files into…`}
      confirmLabel={(where) => `Copy into ${where}`}
      onChoose={onChoose}
      onCancel={onCancel}
      busy={busy}
    />
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
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus and stem-selection together, so the extension stays unselected on
  // every engine — see renameSelection.
  useEffect(() => {
    const input = inputRef.current
    return input ? focusRenameInput(input) : undefined
  }, [])

  const commit = () => {
    if (settled) return
    setSettled(true)
    onSubmit(value)
  }

  return (
    <input
      ref={inputRef}
      className="edit file-row__rename"
      value={value}
      aria-label={label}
      spellCheck={false}
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
