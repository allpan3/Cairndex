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
  const [name, setName] = useState(existing?.name ?? '')
  const [draft, setDraft] = useState<FilterDraft>(
    () => initialDraft ?? (existing ? expressionToDraft(existing.filter) : emptyDraft()),
  )

  const expr = useMemo(() => draftToExpression(draft), [draft])
  const preview = useFilterPreview(expr)

  const save = () => {
    const payload = { name: name.trim(), filter: expr }
    if (!payload.name) return
    if (existing) {
      update.mutate({ id: existing.id, payload, version: existing.version }, { onSuccess: onSaved })
    } else {
      create.mutate(payload, { onSuccess: onSaved })
    }
  }

  const del = () => {
    if (!existing) return
    remove.mutate(existing.id, { onSuccess: onClose })
  }

  const busy = create.isPending || update.isPending || remove.isPending
  const error = create.error ?? update.error

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="modal__head">
          <h2>{existing ? 'Edit Smart Collection' : 'New Smart Collection'}</h2>
          <button className="modal__close" onClick={onClose} aria-label="Close">
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

        <FilterBuilder draft={draft} onChange={setDraft} />

        <div className="modal__preview">
          {preview.isLoading
            ? 'Counting…'
            : `${(preview.data ?? 0).toLocaleString()} matching bundle${preview.data === 1 ? '' : 's'}`}
        </div>

        {error && <div className="modal__error">{(error as Error).message}</div>}

        <div className="modal__actions">
          {existing && (
            <button className="btn btn--danger" onClick={del} disabled={busy}>
              Delete
            </button>
          )}
          <span className="toolbar__spacer" />
          <button className="btn" onClick={onClose} disabled={busy}>
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
