import { type ReactNode, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useModalDialog } from './useModalDialog'
import { FAMILIES } from '../api/catalog'
import { formatBytes } from '../lib/format'
import { leaf, purgeTask, trashRows, trashRowTask, type TrashRow } from './sourceActions'
import { folderLabel, parentFolder } from './sourceTasks'
import type { useTrash } from './useSourceLists'
import type { SourceTasks } from './useSourceTasks'

const rowKey = (row: TrashRow) => `${row.kind}:${row.id}:${row.kind === 'replaced' ? row.path : ''}`

/**
 * The library's Trash: what Move to Trash removed, with Put Back, and the
 * earlier versions Replace kept, with Restore a Copy. Nothing here is ever
 * deleted automatically; both actions are journaled operations of their own.
 */
export function CatalogTrashBrowser({
  trash,
  tasks,
  writable,
  headerLeading,
  headerTrailing,
  onReviewEntity,
}: {
  trash: ReturnType<typeof useTrash>
  tasks: SourceTasks
  writable: boolean
  headerLeading?: ReactNode
  headerTrailing?: ReactNode
  onReviewEntity: (family: string, id: string) => void
}) {
  const { receipts, rows } = trash
  const [empty, setEmpty] = useState<TrashRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const request = useRef(0)
  useEffect(
    () => () => {
      request.current += 1
    },
    [],
  )
  const eligible = (items: TrashRow[]) =>
    items.filter((row) => row.kind === 'trashed' && row.receipt.action === 'retain' && !row.pending)
  const deletable = eligible(rows)
  const closeEmpty = () => {
    request.current += 1
    setEmpty(null)
    setLoading(false)
  }
  const prepareEmpty = async () => {
    const current = ++request.current
    setEmpty([])
    setLoadError(null)
    setLoading(true)
    try {
      let result = await receipts.refetch()
      while (current === request.current && !result.error && result.data?.pages.at(-1)?.next_cursor)
        result = await receipts.fetchNextPage()
      if (current !== request.current) return
      if (result.error) throw result.error
      setEmpty(eligible(trashRows(result.data?.pages ?? [])))
    } catch {
      if (current === request.current)
        setLoadError('The Trash could not be loaded. Close this dialog and try again.')
    } finally {
      if (current === request.current) setLoading(false)
    }
  }
  const busy = tasks.tasks.length > 0
  return (
    <div className="file-browser trash-browser">
      <div className="file-browser__bar">
        <div className="toolbar" data-tauri-drag-region="deep">
          {headerLeading}
          <span className="toolbar__title">Trash</span>
          <span className="toolbar__spacer" />
          <button
            className="btn btn--sm"
            disabled={!writable || busy || (deletable.length === 0 && !receipts.hasNextPage)}
            onClick={() => void prepareEmpty()}
          >
            Empty Trash…
          </button>
          {headerTrailing}
        </div>
      </div>
      {empty && (
        <EmptyTrashDialog
          count={empty.length}
          loading={loading}
          error={loadError}
          disabled={!writable || busy}
          onClose={closeEmpty}
          onConfirm={() => {
            tasks.start(purgeTask(empty))
            setEmpty(null)
          }}
        />
      )}
      <div className="trash-browser__body">
        {receipts.isPending && <p className="modal__note">Loading the Trash…</p>}
        {receipts.error && (
          <p role="alert">
            {receipts.error.message}{' '}
            <button className="btn btn--sm" onClick={() => void receipts.refetch()}>
              Retry
            </button>
          </p>
        )}
        {receipts.data && rows.length === 0 && (
          <p className="trash-browser__empty">The Trash is empty.</p>
        )}
        {!writable && rows.length > 0 && (
          <p className="modal__note">Turn on write mode in Libraries to put items back.</p>
        )}
        <ul className="trash-browser__list" aria-label="Trash">
          {rows.map((row) => {
            const key = rowKey(row)
            const path = row.kind === 'trashed' ? row.receipt.source : row.path
            // A trashed file's bundle keeps its metadata; review shows what came along
            const kept =
              row.kind === 'trashed'
                ? (row.receipt.metadata?.changes ?? []).find(
                    (change) => change.unit.endsWith('/$alive') && change.value === 'false',
                  )
                : undefined
            const [family, identity] = kept?.unit.split('/') ?? []
            return (
              <li key={key} className="trash-browser__row">
                <span className="trash-browser__name" title={path}>
                  {leaf(path)}
                </span>
                <span className="trash-browser__where">
                  {row.kind === 'trashed'
                    ? `From ${folderLabel(parentFolder(path))}`
                    : `Replaced version · ${formatBytes(row.size)}`}
                  {row.pending && ' · Saving its metadata…'}
                </span>
                <span className="trash-browser__actions">
                  {family && identity && (
                    <button
                      className="btn btn--sm"
                      title="Review the metadata this file kept"
                      onClick={() => onReviewEntity(family, identity)}
                    >
                      Review {FAMILIES[family] ?? family}…
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    disabled={
                      !writable ||
                      row.pending ||
                      tasks.tasks.some((task) =>
                        task.items.some((item) => item.request.prior === row.id),
                      )
                    }
                    onClick={() => {
                      tasks.start(trashRowTask(row))
                    }}
                  >
                    {row.kind === 'trashed' ? 'Put Back' : 'Restore a Copy'}
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
        {receipts.hasNextPage && (
          <button
            className="btn btn--sm"
            disabled={receipts.isFetchingNextPage}
            onClick={() => void receipts.fetchNextPage()}
          >
            Show Older
          </button>
        )}
      </div>
    </div>
  )
}

function EmptyTrashDialog({
  count,
  loading,
  error,
  disabled,
  onClose,
  onConfirm,
}: {
  count: number
  loading: boolean
  error: string | null
  disabled: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const { ref, close } = useModalDialog(onClose)
  return createPortal(
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        ref={ref}
        className="modal modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="empty-trash-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="empty-trash-title">Empty Trash?</h2>
        {loading ? (
          <p role="status">Loading items…</p>
        ) : error ? (
          <p role="alert">{error}</p>
        ) : count === 0 ? (
          <p>No items are available for permanent deletion. Older recovery copies will remain.</p>
        ) : (
          <p>
            Permanently delete {count === 1 ? 'this item' : `these ${count} items`}? This cannot be
            undone. Older recovery copies will remain.
          </p>
        )}
        <div className="modal__actions">
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn btn--danger"
            disabled={disabled || loading || !!error || count === 0}
            onClick={onConfirm}
          >
            Delete Permanently
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
