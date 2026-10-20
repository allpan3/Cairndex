import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CatalogJobError, operationId } from '../api/catalog'
import {
  deleteSmartCollection,
  openSmartCollection,
  saveSmartCollection,
  type SmartCollectionOpening,
} from '../api/catalogSmartCollections'
import { captureRequestScope } from '../api/requestScope'
import { draftToExpression, FIELDS } from './filterModel'
import { SmartCollectionForm } from './SmartCollectionEditor'
import { smartCollectionInput, type SmartCollectionInput } from './smartCollectionModel'
import { useCatalogDraft } from './useCatalogDraft'
import { useModalDialog } from './useModalDialog'

type Draft = {
  opening: SmartCollectionOpening
  input: SmartCollectionInput
  operation: string
  pending: 'save' | 'delete' | null
}

function decode(raw: string, id: string | null): Draft {
  const value = JSON.parse(raw) as Draft
  const opening = value.opening
  const input = value.input
  if (
    !opening ||
    !input ||
    typeof input.name !== 'string' ||
    typeof input.conditionsEdited !== 'boolean' ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(value.operation) ||
    ![null, 'save', 'delete'].includes(value.pending)
  )
    throw new Error('Invalid retained Smart Collection draft')
  if (input.draft !== null) {
    const draft = input.draft
    if (
      !['all', 'any'].includes(draft.match) ||
      !Array.isArray(draft.rows) ||
      !draft.rows.every((row) => {
        const field = FIELDS.find((item) => item.field === row.field)
        if (
          !field ||
          !field.operators.includes(row.operator) ||
          typeof row.include_descendants !== 'boolean'
        )
          return false
        if (row.operator === 'is_null') return typeof row.value === 'boolean'
        const kind = field.kind
        return kind === 'tags' || kind === 'collections'
          ? Array.isArray(row.value) && row.value.every((item) => typeof item === 'string')
          : kind === 'number' || kind === 'rating'
            ? typeof row.value === 'number' && Number.isFinite(row.value)
            : kind === 'bool'
              ? typeof row.value === 'boolean'
              : typeof row.value === 'string'
      })
    )
      throw new Error('Invalid retained filter conditions')
  }
  if (input.conditionsEdited && input.draft === null)
    throw new Error('Invalid retained filter conditions')
  if (id) {
    const entity = opening.entity
    if (
      !entity ||
      entity.family !== 'smart_folders' ||
      entity.id !== id ||
      opening.existing?.id !== id ||
      !Array.isArray(entity.parents) ||
      !entity.parents.every((parent) => typeof parent === 'string') ||
      !['name', '$filter', '$alive'].every((column) => entity.fields[column]) ||
      !Object.entries(entity.fields).every(
        ([column, field]) =>
          field.unit === `smart_folders/${id}/${column}` &&
          typeof field.value === 'string' &&
          field.held === null &&
          Array.isArray(field.basis) &&
          field.basis.every((revision) => typeof revision === 'string'),
      )
    )
      throw new Error('Invalid retained Smart Collection bases')
  } else if (
    opening.entity !== null ||
    opening.existing !== null ||
    !opening.cells ||
    !Object.values(opening.cells).every((cell) => typeof cell === 'string') ||
    !opening.cells.id ||
    !opening.cells.filter_json
  )
    throw new Error('Invalid retained creation values')
  return value
}

function Editor({
  library,
  editor,
  opening,
  deleting,
  onClose,
  onSaved,
  onReview,
}: {
  library: string
  editor: string
  opening: SmartCollectionOpening
  deleting: boolean
  onClose: () => void
  onSaved: (id: string | null) => Promise<void>
  onReview: () => void
}) {
  const id = opening.entity?.id ?? null
  const storage = useCatalogDraft(
    library,
    `smart-collection/${id ?? 'new'}`,
    editor,
    {
      data: JSON.stringify({
        opening,
        input: smartCollectionInput(opening.existing),
        operation: operationId(),
        pending: null,
      } satisfies Draft),
    },
    (body) => {
      try {
        decode(body.data, id)
        return true
      } catch {
        return false
      }
    },
  )
  const draft = decode(storage.body.data, id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(deleting)
  const update = (next: Draft) => storage.update({ data: JSON.stringify(next) })
  const run = async () => {
    if (busy) return
    const current = captureRequestScope()
    const action = draft.pending ?? (confirmDelete ? 'delete' : 'save')
    const intent = { ...draft, pending: action }
    update(intent)
    setBusy(true)
    setError('')
    try {
      let saved: string | null = null
      if (action === 'delete')
        await deleteSmartCollection(library, intent.opening, intent.operation)
      else
        saved = await saveSmartCollection(
          library,
          intent.opening,
          intent.input.name,
          !intent.opening.entity || intent.input.conditionsEdited
            ? draftToExpression(intent.input.draft!)
            : null,
          intent.operation,
        )
      current()
      await storage.discard()
      await onSaved(saved)
    } catch (reason) {
      try {
        current()
      } catch {
        return
      }
      setError((reason as Error).message)
      // A rejected job changed nothing. A lost reply must retry its exact intent.
      if (reason instanceof CatalogJobError)
        update({ ...intent, pending: null, operation: operationId() })
    } finally {
      setBusy(false)
    }
  }
  const removing = draft.pending === 'delete' || (!draft.pending && confirmDelete)
  const discard = async () => {
    setBusy(true)
    try {
      await storage.discard()
      onClose()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <SmartCollectionForm
      existing={draft.opening.existing}
      input={draft.input}
      onChange={(input) => update({ ...draft, input, operation: operationId() })}
      onClose={onClose}
      onSave={() => void run()}
      onDelete={id && !removing ? () => setConfirmDelete(true) : undefined}
      onDiscard={draft.pending === null ? () => void discard() : undefined}
      busy={busy}
      locked={removing || draft.pending !== null}
      saveLabel={removing ? 'Delete Smart Collection' : draft.pending ? 'Retry save' : undefined}
      error={error ? new Error(error) : storage.error ? new Error(storage.error) : undefined}
    >
      {removing ? (
        <p>Delete this Smart Collection? Its bundles and source files stay in the library.</p>
      ) : (
        <p>Unsaved changes stay in a private draft when you close this dialog.</p>
      )}
      {error && (
        <button className="btn" disabled={busy} onClick={onReview}>
          Review metadata
        </button>
      )}
      {storage.copies.map((copy) => (
        <button
          className="btn"
          key={copy.id}
          disabled={busy || draft.pending !== null}
          onClick={() => storage.update(copy.body)}
        >
          Recover Smart Collection draft {copy.revision}
        </button>
      ))}
    </SmartCollectionForm>
  )
}

export function CatalogSmartCollectionEditor(props: {
  library: string
  editor: string
  id: string | null
  deleting?: boolean
  onClose: () => void
  onSaved: (id: string | null) => Promise<void>
  onReview: () => void
}) {
  const [instance] = useState(operationId)
  const opening = useQuery({
    queryKey: ['catalog-smart-opening', props.library, props.id, instance],
    queryFn: () => openSmartCollection(props.library, props.id),
    retry: false,
  })
  const { ref, close } = useModalDialog(props.onClose)
  return opening.data ? (
    <Editor {...props} opening={opening.data} deleting={props.deleting ?? false} />
  ) : (
    <div className="modal-backdrop" onMouseDown={close}>
      <div
        className="modal"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Smart Collection"
        onMouseDown={(event) => event.stopPropagation()}
      >
        {opening.isPending ? (
          <p role="status">Opening Smart Collection…</p>
        ) : (
          <p role="alert">{opening.error?.message}</p>
        )}
        {opening.error && (
          <>
            <button onClick={() => void opening.refetch()}>Retry</button>
            <button onClick={props.onReview}>Review metadata</button>
          </>
        )}
        <button onClick={close}>Close</button>
      </div>
    </div>
  )
}
