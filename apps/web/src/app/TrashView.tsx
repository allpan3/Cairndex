import { useState } from 'react'

import { useEmptyTrash, useRestoreFromTrash, useTrash } from '../api/hooks'
import { formatBytes, formatDate } from '../lib/format'
import { IconFolder, IconTrash } from './icons'

/**
 * The Trash: everything deleted from this library and still recoverable
 * (ADR-0013 §3.2).
 *
 * Grouped by deletion rather than flattened into files, because a deletion is
 * what restore acts on — trashing a folder of forty episodes is one decision,
 * and undoing it should be one decision too, not forty.
 *
 * A Files-surface scope like Unbundled rather than a bundle browse view: the
 * things in it are files, some of which were never in a bundle at all.
 *
 * With write mode off the view is read-only: the server keeps the listing
 * readable so trashed files never look permanently gone, but restore and Empty
 * Trash are write operations it would refuse. The buttons stay visible and
 * disabled — a control that disappears reads as a file that cannot come back.
 */
export function TrashView({
  writeMode,
  onFlash,
}: {
  writeMode: boolean
  onFlash: (message: string) => void
}) {
  const trash = useTrash()
  const restore = useRestoreFromTrash()
  const empty = useEmptyTrash()
  const [confirmingEmpty, setConfirmingEmpty] = useState(false)

  const operations = trash.data?.operations ?? []
  const size = trash.data?.size_bytes ?? 0
  const busy = restore.isPending || empty.isPending
  const readOnlyHint = writeMode
    ? undefined
    : 'Write mode is off for this library. Turn it back on to do this.'

  const restoreOne = (operationId: string) =>
    restore.mutate(operationId, {
      onSuccess: (result) => onFlash(`Restored to “${result.path}”.`),
      onError: (failure) => onFlash(messageOf(failure)),
    })

  const emptyAll = () =>
    empty.mutate(undefined, {
      onSuccess: (result) => {
        setConfirmingEmpty(false)
        const count = result.operations_emptied
        onFlash(count === 1 ? 'Emptied 1 deletion.' : `Emptied ${count} deletions.`)
      },
      onError: (failure) => {
        setConfirmingEmpty(false)
        onFlash(messageOf(failure))
      },
    })

  return (
    <>
      <div className="toolbar" data-tauri-drag-region="deep">
        <span className="toolbar__title">Trash</span>
        <span className="toolbar__count">
          {operations.length.toLocaleString()} {operations.length === 1 ? 'deletion' : 'deletions'}
          {size > 0 && ` · ${formatBytes(size)}`}
        </span>
        {!writeMode && operations.length > 0 && (
          <span className="toolbar__count">
            Write mode is off — these files stay recoverable, but restoring needs it back on.
          </span>
        )}
        <span className="toolbar__spacer" />
        {operations.length > 0 && !confirmingEmpty && (
          <button
            className="btn btn--sm"
            onClick={() => setConfirmingEmpty(true)}
            disabled={busy || !writeMode}
            title={readOnlyHint}
          >
            Empty Trash…
          </button>
        )}
        {confirmingEmpty && (
          <>
            {/* The one action in write mode with no way back, so it says so
                in those words rather than "are you sure?". */}
            <span className="trash__warning">
              Delete {size > 0 ? formatBytes(size) : 'everything'} permanently? This cannot be
              undone.
            </span>
            <button
              className="btn btn--sm"
              onClick={() => setConfirmingEmpty(false)}
              disabled={busy}
            >
              Cancel
            </button>
            <button className="btn btn--sm btn--danger" onClick={emptyAll} disabled={busy}>
              Delete permanently
            </button>
          </>
        )}
      </div>

      <div className="file-browser__body">
        {trash.isLoading ? (
          <div className="empty">Loading…</div>
        ) : trash.isError ? (
          <div className="empty empty--error">Could not load the trash.</div>
        ) : operations.length === 0 ? (
          <div className="empty">
            The trash is empty. Deleted files are kept here until you empty it.
          </div>
        ) : (
          <div className="trash-list">
            {operations.map((operation) => (
              <div className="trash-group" key={operation.operation_id}>
                <div className="trash-group__head">
                  <span className="trash-group__icon">
                    <IconTrash />
                  </span>
                  <span className="trash-group__when">
                    {operation.deleted_at ? formatDate(operation.deleted_at) : 'Deleted'}
                  </span>
                  <span className="trash-group__count">
                    {operation.entries.length === 1
                      ? '1 item'
                      : `${operation.entries.length} items`}
                  </span>
                  <span className="toolbar__spacer" />
                  <button
                    className="btn btn--sm"
                    onClick={() => restoreOne(operation.operation_id)}
                    disabled={busy || !writeMode}
                    title={readOnlyHint}
                  >
                    Put back
                  </button>
                </div>
                {operation.entries.map((entry) => (
                  <div className="trash-row" key={entry.original_path}>
                    <span className="trash-row__name">
                      {entry.is_directory && (
                        <span className="file-row__icon">
                          <IconFolder />
                        </span>
                      )}
                      {entry.name}
                    </span>
                    {/* Where it goes back to, which is the thing a user is
                        actually checking before pressing Put back. */}
                    <span className="trash-row__path">{entry.original_path}</span>
                    <span className="file-table__num">
                      {entry.size_bytes === null ? '' : formatBytes(entry.size_bytes)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  return 'That could not be done.'
}
