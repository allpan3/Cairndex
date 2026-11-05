import { useState } from 'react'
import { FolderPicker } from './FolderPicker'
import { newFolderTask, renameError, relocationTask, trashTask, what } from './sourceActions'
import { folderLabel, parentFolder } from './sourceTasks'
import { useModalDialog } from './useModalDialog'
import type { NewTask } from './useSourceTasks'

/** Copy to… and Move to…: the folder is the only question. */
export function RelocateDialog({
  library,
  action,
  paths,
  onClose,
  onStart,
}: {
  library: string
  action: 'copy' | 'move'
  paths: string[]
  onClose: () => void
  onStart: (task: NewTask) => void
}) {
  const [folder, setFolder] = useState(parentFolder(paths[0] ?? ''))
  const { ref, close } = useModalDialog(onClose)
  const unchanged = action === 'move' && paths.every((path) => parentFolder(path) === folder)
  const label = action === 'copy' ? 'Copy' : 'Move'
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="relocate-title"
        className="modal incoming"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="relocate-title">
            {label} {what(paths)} to {folderLabel(folder)}
          </h2>
        </div>
        <div className="incoming__field">
          <span>Folder</span>
          <FolderPicker
            library={library}
            value={folder}
            onChange={setFolder}
            exclude={action === 'move' ? paths : []}
            startOpen
          />
        </div>
        {unchanged && <p className="modal__note">Choose a different folder to move to.</p>}
        <div className="modal__actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={unchanged}
            onClick={() => {
              onStart(relocationTask(action, paths, folder))
              onClose()
            }}
          >
            {label}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Move to Trash asks once; Trash in the sidebar puts things back. */
export function TrashDialog({
  paths,
  onClose,
  onStart,
}: {
  paths: string[]
  onClose: () => void
  onStart: (task: NewTask) => void
}) {
  const { ref, close } = useModalDialog(onClose)
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="trash-title"
        className="modal incoming"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id="trash-title">Move {what(paths)} to the Trash?</h2>
        </div>
        <p className="modal__note">
          You can put {paths.length === 1 ? 'it' : 'them'} back from Trash in the sidebar.
        </p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={close}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              onStart(trashTask(paths))
              onClose()
            }}
          >
            Move to Trash
          </button>
        </div>
      </div>
    </div>
  )
}

/** New Folder keeps invalid names in the dialog for correction. */
export function NewFolderDialog({
  folder,
  onClose,
  onStart,
}: {
  folder: string
  onClose: () => void
  onStart: (task: NewTask) => void
}) {
  const [name, setName] = useState('New Folder')
  const { ref, close } = useModalDialog(onClose)
  const trimmed = name.trim()
  const error =
    renameError(trimmed) ??
    (trimmed.startsWith('.') || trimmed.endsWith('.')
      ? 'A folder name cannot start or end with a dot.'
      : null)
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-folder-title"
        className="modal modal--narrow"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!trimmed || error) return
            onStart(newFolderTask(folder, trimmed))
            onClose()
          }}
        >
          <div className="modal__head">
            <h2 id="new-folder-title">New Folder</h2>
          </div>
          <p className="modal__note">In {folderLabel(folder)}</p>
          <label className="incoming__field">
            Folder name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onFocus={(event) => event.target.select()}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'new-folder-error' : undefined}
            />
          </label>
          {error && (
            <p id="new-folder-error" role="alert" className="modal__note">
              {error}
            </p>
          )}
          <div className="modal__actions">
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn--primary"
              disabled={!trimmed || Boolean(error)}
            >
              Create
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
