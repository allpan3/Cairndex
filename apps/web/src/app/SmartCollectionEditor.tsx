import { useModalDialog } from './useModalDialog'
import { useMemo, useState } from 'react'

import type { SmartCollectionRead } from '../api/client'
import { useFilterPreview, useSmartCollectionMutations } from '../api/hooks'
import { FilterBuilder } from './FilterBuilder'
import { type FilterDraft, draftToExpression, emptyDraft, expressionToDraft } from './filterModel'

/**
 * Create or edit a Smart Collection. Wraps the shared FilterBuilder with a name
 * field and a live match count (the same compile path the saved collection will
 * use when browsed), so what you preview is what you get.
 */
export function SmartCollectionEditor({
  existing,
  initialDraft,
  onClose,
  onSaved,
}: {
  existing?: SmartCollectionRead | null
  initialDraft?: FilterDraft
  onClose: () => void
  onSaved: (sc: SmartCollectionRead) => void
}) {
  const { create, update, remove } = useSmartCollectionMutations()
  // Keep the accepted expression and concurrency basis from when this editor opened
  const [original] = useState(existing)
  const [name, setName] = useState(existing?.name ?? '')
  const [draft, setDraft] = useState<FilterDraft | null>(
    () => initialDraft ?? (existing ? expressionToDraft(existing.filter) : emptyDraft()),
  )
  const [conditionsEdited, setConditionsEdited] = useState(false)

  const expr = useMemo(
    () =>
      original && !conditionsEdited ? original.filter : draftToExpression(draft ?? emptyDraft()),
    [original, conditionsEdited, draft],
  )
  const preview = useFilterPreview(expr)

  const save = () => {
    const payload = { name: name.trim() }
    if (!payload.name) return
    if (original) {
      update.mutate(
        {
          id: original.id,
          payload: conditionsEdited ? { ...payload, filter: expr } : payload,
          version: original.version,
        },
        { onSuccess: onSaved },
      )
    } else {
      create.mutate({ ...payload, filter: expr }, { onSuccess: onSaved })
    }
  }

  const del = () => {
    if (!existing) return
    remove.mutate(existing.id, { onSuccess: onClose })
  }

  const busy = create.isPending || update.isPending || remove.isPending
  const error = create.error ?? update.error

  const { ref: dialogRef, close: closeDialog } = useModalDialog(onClose, busy)

  return (
    <div className="modal-backdrop" onMouseDown={closeDialog}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={existing ? 'Edit Smart Collection' : 'New Smart Collection'}
      >
        <div className="modal__head">
          <h2>{existing ? 'Edit Smart Collection' : 'New Smart Collection'}</h2>
          <button className="modal__close" onClick={closeDialog} aria-label="Close">
            ×
          </button>
        </div>

        <input
          className="edit edit--title"
          value={name}
          placeholder="Smart collection name"
          onChange={(e) => setName(e.target.value)}
          aria-label="Smart collection name"
          autoFocus
        />

        {draft ? (
          <FilterBuilder
            draft={draft}
            onChange={(next) => {
              setDraft(next)
              setConditionsEdited(true)
            }}
          />
        ) : (
          <p role="note">
            These saved conditions use advanced rules. They are preserved; only the name can be
            edited here.
          </p>
        )}

        <div className="modal__preview">
          {preview.isError ? (
            <span role="alert">
              Could not count matches.{' '}
              <button className="btn" onClick={() => void preview.refetch()}>
                Retry preview
              </button>
            </span>
          ) : preview.isLoading ? (
            'Counting…'
          ) : (
            `${(preview.data ?? 0).toLocaleString()} matching bundle${preview.data === 1 ? '' : 's'}`
          )}
        </div>

        {error && (
          <div className="modal__error" role="alert">
            {(error as Error).message}
          </div>
        )}

        <div className="modal__actions">
          {existing && (
            <button className="btn btn--danger" onClick={del} disabled={busy}>
              Delete
            </button>
          )}
          <span className="toolbar__spacer" />
          <button className="btn" onClick={closeDialog} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={save} disabled={busy || !name.trim()}>
            {existing ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
