import { type ReactNode, useState } from 'react'
import { FAMILIES } from '../api/catalog'
import { formatBytes } from '../lib/format'
import { leaf, trashRowTask, type TrashRow } from './sourceActions'
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
  // A row leaves once its task's refresh lands; until then it cannot start twice
  const [started, setStarted] = useState(new Set<string>())
  const { receipts, rows } = trash
  return (
    <div className="file-browser trash-browser">
      <div className="file-browser__bar">
        <div className="toolbar" data-tauri-drag-region="deep">
          {headerLeading}
          <span className="toolbar__title">Trash</span>
          <span className="toolbar__spacer" />
          {headerTrailing}
        </div>
      </div>
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
                    disabled={!writable || row.pending || started.has(key)}
                    onClick={() => {
                      setStarted((current) => new Set(current).add(key))
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
