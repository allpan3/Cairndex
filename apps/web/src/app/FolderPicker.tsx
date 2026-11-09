import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { folderListing } from './folderListing'
import { newFolderError } from './sourceActions'
import { folderLabel } from './sourceTasks'

/**
 * Chooses one library folder: the chosen folder as a path you can click back
 * up, and, on request, its subfolders to go further down. `value` is always a
 * folder the server listed. With `allowNew`, `pending` names folders to create
 * inside it, in order; they appear after it, marked new, and the caller creates
 * them before using the folder. `exclude` hides paths that cannot be the
 * answer, such as a folder being moved.
 */
export function FolderPicker({
  library,
  value,
  pending = [],
  onChange,
  exclude = [],
  startOpen = false,
  allowNew = false,
}: {
  library: string
  value: string
  pending?: readonly string[]
  onChange: (folder: string, pending: string[]) => void
  exclude?: string[]
  startOpen?: boolean
  allowNew?: boolean
}) {
  const [open, setOpen] = useState(startOpen)
  const [naming, setNaming] = useState<string | null>(null)
  const listing = useQuery({ ...folderListing(library, value), enabled: open })
  const parts = value ? value.split('/') : []
  const folders = (listing.data?.entries ?? []).filter(
    (entry) => entry.kind === 'directory' && !exclude.includes(entry.relative_path),
  )
  const nameError = naming === null ? null : newFolderError(naming.trim())
  function create() {
    const name = naming?.trim() ?? ''
    if (newFolderError(name)) return
    setNaming(null)
    // An existing folder of that name is chosen, never created a second time
    const existing =
      pending.length === 0 && folders.find((entry) => entry.name === name)?.relative_path
    if (existing) onChange(existing, [])
    else onChange(value, [...pending, name])
  }
  return (
    <div className="folder-picker">
      <div className="folder-picker__path" aria-label="Chosen folder">
        <button
          type="button"
          className="folder-picker__crumb"
          aria-current={parts.length === 0 && pending.length === 0 ? 'location' : undefined}
          onClick={() => onChange('', [])}
        >
          Library
        </button>
        {parts.map((part, index) => (
          <span key={index}>
            <span className="folder-picker__sep">/</span>
            <button
              type="button"
              className="folder-picker__crumb"
              aria-current={
                index === parts.length - 1 && pending.length === 0 ? 'location' : undefined
              }
              onClick={() => onChange(parts.slice(0, index + 1).join('/'), [])}
            >
              {part}
            </button>
          </span>
        ))}
        {pending.map((part, index) => (
          <span key={`new-${index}`}>
            <span className="folder-picker__sep">/</span>
            <button
              type="button"
              className="folder-picker__crumb folder-picker__crumb--new"
              aria-current={index === pending.length - 1 ? 'location' : undefined}
              aria-label={`${part} (new folder)`}
              onClick={() => onChange(value, pending.slice(0, index + 1))}
            >
              {part}
            </button>
            <span className="folder-picker__new" aria-hidden="true">
              new folder
            </span>
          </span>
        ))}
        {!open && (
          <button type="button" className="btn btn--sm" onClick={() => setOpen(true)}>
            Change…
          </button>
        )}
      </div>
      {open && (
        <ul
          className="folder-picker__list"
          aria-label={`Folders in ${pending.at(-1) ?? folderLabel(value)}`}
        >
          {pending.length > 0 ? (
            <li className="modal__note">
              “{pending.at(-1)}” is new. Cairndex creates it when the copy starts.
            </li>
          ) : (
            <>
              {listing.isPending && <li className="modal__note">Loading folders…</li>}
              {listing.error && (
                <li role="alert">
                  {listing.error.message}{' '}
                  <button className="btn btn--sm" onClick={() => void listing.refetch()}>
                    Retry
                  </button>
                </li>
              )}
              {listing.data && folders.length === 0 && (
                <li className="modal__note">No folders inside {folderLabel(value)}.</li>
              )}
              {folders.map((entry) => (
                <li key={entry.relative_path}>
                  <button
                    type="button"
                    className="folder-picker__folder"
                    onClick={() => onChange(entry.relative_path, [])}
                  >
                    {entry.name}
                  </button>
                </li>
              ))}
            </>
          )}
          {allowNew && (
            <li className="folder-picker__create">
              {naming === null ? (
                <button type="button" className="btn btn--sm" onClick={() => setNaming('')}>
                  New Folder…
                </button>
              ) : (
                <>
                  <input
                    className="edit"
                    aria-label="New folder name"
                    autoFocus
                    value={naming}
                    onChange={(event) => setNaming(event.target.value)}
                    onKeyDown={(event) => {
                      // Enter names the folder here; it must not submit the dialog
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        create()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        setNaming(null)
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn--sm"
                    disabled={nameError !== null}
                    onClick={create}
                  >
                    Add
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => setNaming(null)}>
                    Cancel
                  </button>
                  {naming.trim() !== '' && nameError && (
                    <span role="alert" className="folder-picker__error">
                      {nameError}
                    </span>
                  )}
                </>
              )}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}
