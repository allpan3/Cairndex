import { useModalDialog } from './useModalDialog'
import { type ReactNode, useMemo, useState } from 'react'

import type { SmartCollectionRead } from '../api/client'
import { useFilterPreview, useSmartCollectionMutations } from '../api/hooks'
import { FilterBuilder } from './FilterBuilder'
import { type FilterDraft, draftToExpression, emptyDraft } from './filterModel'
import { smartCollectionInput, type SmartCollectionInput } from './smartCollectionModel'

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
  const [input, setInput] = useState(() => ({
    ...smartCollectionInput(existing),
    ...(initialDraft ? { draft: initialDraft } : {}),
  }))
  return (
    <SmartCollectionForm
      existing={original}
      input={input}
      onChange={setInput}
      onClose={onClose}
      busy={create.isPending || update.isPending || remove.isPending}
      error={create.error ?? update.error ?? remove.error}
      onDelete={original ? () => remove.mutate(original.id, { onSuccess: onClose }) : undefined}
      onSave={(expr) => {
        const payload = { name: input.name.trim() }
        if (!payload.name) return
        if (original) {
          update.mutate(
            {
              id: original.id,
              payload: input.conditionsEdited ? { ...payload, filter: expr } : payload,
              version: original.version,
            },
            { onSuccess: onSaved },
          )
        } else {
          create.mutate({ ...payload, filter: expr }, { onSuccess: onSaved })
        }
      }}
    />
  )
}

/** Shared ordinary controls; each storage workflow owns its bases and draft delivery. */
export function SmartCollectionForm({
  existing,
  input,
  onChange,
  onClose,
  onSave,
  onDelete,
  onDiscard,
  busy,
  error,
  locked = false,
  saveLabel,
  children,
}: {
  existing?: SmartCollectionRead | null
  input: SmartCollectionInput
  onChange: (input: SmartCollectionInput) => void
  onClose: () => void
  onSave: (filter: SmartCollectionRead['filter']) => void
  onDelete?: () => void
  onDiscard?: () => void
  busy: boolean
  error?: unknown
  locked?: boolean
  saveLabel?: string
  children?: ReactNode
}) {
  const { name, draft, conditionsEdited } = input
  const expr = useMemo(
    () =>
      existing && !conditionsEdited ? existing.filter : draftToExpression(draft ?? emptyDraft()),
    [existing, conditionsEdited, draft],
  )
  const preview = useFilterPreview(expr)
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
          onChange={(e) => onChange({ ...input, name: e.target.value })}
          disabled={busy || locked}
          aria-label="Smart collection name"
          autoFocus
        />

        <fieldset disabled={busy || locked} className="smart-collection__conditions">
          {draft ? (
            <FilterBuilder
              draft={draft}
              onChange={(next) => {
                onChange({ ...input, draft: next, conditionsEdited: true })
              }}
            />
          ) : (
            <p role="note">
              These saved conditions use advanced rules. They are preserved; only the name can be
              edited here.
            </p>
          )}
        </fieldset>

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

        {Boolean(error) && (
          <div className="modal__error" role="alert">
            {(error as Error).message}
          </div>
        )}

        {children}
        <div className="modal__actions">
          {onDiscard && (
            <button className="btn" onClick={onDiscard} disabled={busy || locked}>
              Discard draft
            </button>
          )}
          {onDelete && (
            <button className="btn btn--danger" onClick={onDelete} disabled={busy || locked}>
              Delete
            </button>
          )}
          <span className="toolbar__spacer" />
          <button className="btn" onClick={closeDialog} disabled={busy}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={() => onSave(expr)}
            disabled={busy || !name.trim()}
          >
            {saveLabel ?? (existing ? 'Save' : 'Create')}
          </button>
        </div>
      </div>
    </div>
  )
}
