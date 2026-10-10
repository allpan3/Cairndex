import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchMetadataRevision } from '../api/client'
import {
  chooseEdit,
  editStorageWarning,
  editSnapshot,
  openEdit,
  pendingEdits,
  shownEdit,
  subscribeEdits,
  type PendingEdit,
} from '../api/metadataEdits'
import { useModalDialog } from './useModalDialog'
import {
  metadataCompatibility,
  metadataEditingBlocked,
  METADATA_UPGRADE_MESSAGE,
  subscribeMetadataCompatibility,
} from '../api/metadataCompatibility'
import { observeEditClient, currentDisplayedBasis, holdEditBasis } from '../api/editBasis'

// Refresh existing queries only when the small library clock changes or a save needs reconciliation
function MetadataRefresh({ libraryId }: { libraryId: string }) {
  const client = useQueryClient()
  useLayoutEffect(() => observeEditClient(client), [client])
  useEffect(() => {
    let release: (() => void) | undefined
    const begin = () => {
      release?.()
      release = holdEditBasis(currentDisplayedBasis())
    }
    const end = () => {
      const done = release
      release = undefined
      queueMicrotask(() => done?.())
    }
    document.addEventListener('dragstart', begin, true)
    document.addEventListener('dragend', end, true)
    document.addEventListener('drop', end, true)
    return () => {
      release?.()
      document.removeEventListener('dragstart', begin, true)
      document.removeEventListener('dragend', end, true)
      document.removeEventListener('drop', end, true)
    }
  }, [])
  const compatibility = useSyncExternalStore(subscribeMetadataCompatibility, metadataCompatibility)
  const previous = useRef<string | null>(null)
  const needsRefresh = useRef(false)
  const clock = useQuery({
    queryKey: ['metadata-revision', libraryId],
    queryFn: ({ signal }) => fetchMetadataRevision(signal),
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
    retry: false,
    refetchOnWindowFocus: true,
  })
  useEffect(() => {
    const refresh = () => {
      void client.invalidateQueries({
        predicate: (query) =>
          ![
            'metadata-revision',
            'auth-status',
            'library-ownership',
            'library-serving',
            'libraries',
            'active-jobs',
          ].includes(String(query.queryKey[0])),
      })
    }
    window.addEventListener('cairndex:metadata-refresh', refresh)
    window.addEventListener('cairndex:metadata-saved', refresh)
    return () => {
      window.removeEventListener('cairndex:metadata-refresh', refresh)
      window.removeEventListener('cairndex:metadata-saved', refresh)
    }
  }, [client])
  useEffect(() => {
    const basis = clock.data?.basis
    if (!basis || compatibility !== 'supported') return
    if (needsRefresh.current || (previous.current && previous.current !== basis))
      window.dispatchEvent(new Event('cairndex:metadata-refresh'))
    previous.current = basis
    needsRefresh.current = false
  }, [clock.data?.basis, clock.dataUpdatedAt, compatibility])
  useEffect(() => {
    if (compatibility === 'unsupported') needsRefresh.current = true
  }, [compatibility])
  if (compatibility !== 'unsupported' && compatibility !== 'unavailable') return null
  return (
    <section className="metadata-compatibility" role="status" aria-label="Metadata editing status">
      <p>
        {compatibility === 'unsupported'
          ? METADATA_UPGRADE_MESSAGE
          : 'Cannot check metadata editing right now. Check the connection and library access, then try again. Your drafts are kept.'}
      </p>
      <button className="btn" disabled={clock.isFetching} onClick={() => void clock.refetch()}>
        {clock.isFetching ? 'Checking…' : 'Check again'}
      </button>
    </section>
  )
}

// Render literal values safely, preserving every ordered note and line break
function ReviewValue({ value, field }: { value: unknown; field: string }) {
  if (field === 'notes' && typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      /* Preserve malformed historical text verbatim */
    }
  }
  if (value === null || value === '') return <p className="metadata-review__empty">Empty</p>
  if (Array.isArray(value))
    return (
      <ol>
        {value.map((item, index) => (
          <li key={index}>
            <pre>{String(item)}</pre>
          </li>
        ))}
      </ol>
    )
  if (value && typeof value === 'object')
    return (
      <dl>
        {Object.entries(value).map(([name, item]) => (
          <div key={name}>
            <dt>{name.replaceAll('_', ' ')}</dt>
            <dd>
              <pre>{typeof item === 'string' ? item : JSON.stringify(item)}</pre>
            </dd>
          </div>
        ))}
      </dl>
    )
  return <pre>{String(value)}</pre>
}

// A scalar acknowledgement remains tied to exactly the value and revision displayed here
function ReviewDialog({ edit }: { edit: PendingEdit }) {
  const keep = () => void chooseEdit(edit, 'keep')
  const { ref, close } = useModalDialog(keep)
  useSyncExternalStore(subscribeMetadataCompatibility, metadataCompatibility)
  const blocked = metadataEditingBlocked()
  const values = edit.conflict ?? edit.recovery
  const field = edit.conflict?.unit.split('/').at(-1) ?? ''
  return createPortal(
    <div className="modal-backdrop metadata-review" onMouseDown={close}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Review metadata edit"
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2>Review your edit</h2>
          <button aria-label="Close review" onClick={keep}>
            ×
          </button>
        </div>
        <p role="alert">
          {blocked
            ? METADATA_UPGRADE_MESSAGE
            : edit.message === METADATA_UPGRADE_MESSAGE
              ? 'This draft was kept while metadata editing was unavailable. Retry to check whether it can now be saved safely.'
              : edit.message}
        </p>
        {values ? (
          <>
            <div className="metadata-review__values">
              <section>
                <h3>Current value</h3>
                <ReviewValue value={values.current} field={field} />
              </section>
              <section>
                <h3>Your proposed value</h3>
                <ReviewValue value={values.proposed} field={field} />
              </section>
            </div>
            {edit.conflict && !edit.conflict.reviewable && (
              <p>
                The membership, order or item lifetime changed. Keep this draft and reopen the item
                to review its updated arrangement before making a new change.
              </p>
            )}
          </>
        ) : (
          <p>
            The original request is retained. Retrying cannot create a duplicate of a committed
            edit.
          </p>
        )}
        <div className="modal__actions">
          <button className="btn" onClick={() => void chooseEdit(edit, 'discard')}>
            Discard proposed edit
          </button>
          <button className="btn" onClick={keep}>
            Keep draft
          </button>
          {!blocked && (edit.conflict?.reviewable || edit.recovery) && (
            <button className="btn btn--primary" onClick={() => void chooseEdit(edit, 'reviewed')}>
              Use my value
            </button>
          )}
          {!blocked && !values && (
            <button className="btn btn--primary" onClick={() => void chooseEdit(edit, 'retry')}>
              Retry save
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}

// One shared surface covers editor, menu, bulk and recovered request drafts
export function MetadataReview({ libraryId }: { libraryId: string }) {
  useSyncExternalStore(subscribeEdits, editSnapshot)
  const pending = pendingEdits()
  const edit = shownEdit()
  return (
    <>
      <div className="metadata-status">
        <MetadataRefresh libraryId={libraryId} />
      </div>
      {editStorageWarning() && (
        <p role="alert" className="metadata-drafts">
          Pending edits are kept in this session only. Browser storage is unavailable.
        </p>
      )}
      {pending.some((item) => item.message) && (
        <div className="metadata-drafts" aria-label="Unsaved metadata edits">
          {pending
            .filter((item) => item.message)
            .map((item, index) => (
              <button className="btn" key={item.id} onClick={() => openEdit(item.id)}>
                Review unsaved edit {index + 1}
              </button>
            ))}
        </div>
      )}
      {edit && (
        <ReviewDialog key={`${edit.id}:${edit.conflict?.revision ?? edit.message}`} edit={edit} />
      )}
    </>
  )
}
