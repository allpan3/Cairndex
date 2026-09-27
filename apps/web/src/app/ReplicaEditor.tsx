// Bundle metadata editor with durable private drafts and field-scoped recovery
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { components } from '../api/schema'
import {
  replicaRequest,
  draftKey,
  displayValue,
  type ReplicaBundle,
  type Changes,
  type Change,
  type Draft,
  type FieldName,
  type Value,
} from '../api/replicas'

const LABEL: Record<FieldName, string> = {
  title: 'Title',
  notes: 'Notes (whole ordered list)',
  rating: 'Rating',
}
const FIELDS: FieldName[] = ['title', 'notes', 'rating']

// Recover only recognizable editor state; unreadable storage is left untouched
function loadDraft(key: string): { draft: Draft | null; error: string } {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { draft: null, error: '' }
    const value = JSON.parse(raw) as Draft
    if (!value.id || !Number.isInteger(value.revision) || !value.changes)
      throw new Error('Invalid draft')
    return { draft: value, error: '' }
  } catch {
    return { draft: null, error: 'The saved local draft could not be read. It has been retained.' }
  }
}

// Authored changes retain their original basis even as remote fields refresh
export function ReplicaEditor({
  libraryId,
  bundle,
  editor,
  blocked,
  refresh,
}: {
  libraryId: string
  bundle: ReplicaBundle
  editor: string
  blocked: boolean
  refresh: () => void
}) {
  const key = draftKey(libraryId, bundle.id, editor)
  const [initial] = useState(() => loadDraft(key))
  const [draft, setDraft] = useState<Draft | null>(initial.draft)
  const [error, setError] = useState(initial.error)
  const [message, setMessage] = useState('')
  const [saving, setSaving] = useState(false)
  const cancelDraftDelivery = useRef(() => {})
  const [review, setReview] = useState<{
    field: FieldName
    value: Value
    basis: string[]
    operation: string
  } | null>(null)
  const [historyField, setHistoryField] = useState<FieldName | null>(null)
  const [historyCursor, setHistoryCursor] = useState('')
  const [draftCursor, setDraftCursor] = useState('')
  const base = `/bundles/${bundle.id}`
  const [localRecovery] = useState(() => {
    const prefix = key.slice(0, key.lastIndexOf(':') + 1)
    const found: Draft[] = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const candidate = localStorage.key(i)
        if (!candidate?.startsWith(prefix) || candidate === key) continue
        const saved = loadDraft(candidate).draft
        if (saved) found.push(saved)
      }
    } catch {
      /* The server recovery list remains available */
    }
    return found
  })
  const drafts = useQuery({
    queryKey: [key, 'recovery-drafts', draftCursor],
    queryFn: () =>
      replicaRequest<components['schemas']['DraftPage']>(
        libraryId,
        `${base}/drafts?after=${draftCursor}`,
      ),
    refetchInterval: 5000,
  })
  const history = useQuery({
    queryKey: [key, 'history', historyField, historyCursor],
    queryFn: () =>
      replicaRequest<components['schemas']['HistoryPage']>(
        libraryId,
        `${base}/history/${historyField}?after=${historyCursor}`,
      ),
    enabled: historyField !== null,
  })

  // Private server drafts complement the synchronous browser copy when a request is interrupted
  useEffect(() => {
    if (!draft) return
    let current = true
    const timer = setTimeout(() => {
      void replicaRequest<void>(libraryId, `${base}/drafts/${draft.id}`, 'PUT', {
        revision: draft.revision,
        changes: draft.changes,
      })
        .then(() => {
          if (current) setMessage('Draft saved on this device')
        })
        .catch((reason: Error) => {
          if (current) setError(reason.message)
        })
    }, 250)
    const cancel = () => {
      current = false
      clearTimeout(timer)
    }
    cancelDraftDelivery.current = cancel
    return cancel
  }, [base, draft, libraryId])

  // Cache each keystroke before requesting a server-side draft save
  function change(field: FieldName, value: Value) {
    const next: Draft = {
      id: draft?.id ?? crypto.randomUUID().replaceAll('-', ''),
      revision: (draft?.revision ?? 0) + 1,
      changes: {
        ...draft?.changes,
        [field]: { value, basis: draft?.changes[field]?.basis ?? bundle.fields[field].basis },
      },
    }
    setDraft(next)
    setMessage('Unsaved changes')
    setError('')
    try {
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      setError('Could not preserve a browser draft. Keep this editor open and save your changes.')
    }
  }

  // Saving or explicit discard dismisses only this exact draft generation
  async function clearDraft() {
    // Invalidate draft callbacks before dismissal; effect cleanup can follow the save receipt.
    cancelDraftDelivery.current()
    if (draft)
      await replicaRequest<void>(
        libraryId,
        `/drafts/${draft.id}?revision=${draft.revision}`,
        'DELETE',
      )
    localStorage.removeItem(key)
    setDraft(null)
    void drafts.refetch()
  }

  // Stable operation identity makes an uncertain response safely retryable
  async function save() {
    if (!draft) return
    setSaving(true)
    setError('')
    try {
      await replicaRequest(libraryId, `${base}/edits`, 'POST', {
        operation: `${draft.id}-${draft.revision}`,
        changes: draft.changes,
      })
      await clearDraft()
      setMessage('Saved here')
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }

  // Review captures a field basis now; confirm refuses a changed candidate set later
  async function confirmReview() {
    if (!review) return
    setSaving(true)
    setError('')
    try {
      await replicaRequest(libraryId, `${base}/edits`, 'POST', {
        operation: review.operation,
        resolve: true,
        changes: { [review.field]: { value: review.value, basis: review.basis } },
      })
      setReview(null)
      setMessage('Choice saved here. Other versions remain in history.')
      refresh()
      void history.refetch()
    } catch (reason) {
      setError((reason as Error).message)
      refresh()
    } finally {
      setSaving(false)
    }
  }

  // Recovery is explicit and cannot overwrite an active unsaved editor
  function recover(item: Draft) {
    if (draft) return
    const recovered = { ...item, id: crypto.randomUUID().replaceAll('-', ''), revision: 1 }
    try {
      localStorage.setItem(key, JSON.stringify(recovered))
    } catch {
      setError('Could not preserve the recovered browser draft. Keep this editor open.')
    }
    setDraft(recovered)
    setMessage('Recovered draft; review and save when ready')
  }

  // Untouched fields follow validated imports while locally edited fields retain their basis
  function value(field: FieldName): Value {
    return draft?.changes[field] ? draft.changes[field].value : bundle.fields[field].value
  }
  const notes = value('notes')

  return (
    <article className="replica-editor" aria-label={`Edit ${String(bundle.fields.title.value)}`}>
      <h2>{String(bundle.fields.title.value)}</h2>
      <fieldset disabled={saving || Boolean(initial.error)}>
        <label>
          Title
          <input
            aria-label="Bundle title"
            value={String(value('title') ?? '')}
            onChange={(e) => change('title', e.target.value)}
          />
        </label>
        <label>
          Rating
          <select
            aria-label="Bundle rating"
            value={value('rating') === null ? '' : String(value('rating'))}
            onChange={(e) =>
              change('rating', e.target.value === '' ? null : Number(e.target.value))
            }
          >
            <option value="">Unrated</option>
            {Array.from({ length: 11 }, (_, i) => (
              <option key={i} value={i / 2}>
                {i / 2} stars
              </option>
            ))}
          </select>
        </label>
        <div>
          <span>Notes · ordered list</span>
          {(Array.isArray(notes) ? notes : []).map((note, i) => (
            <label key={i}>
              Note {i + 1}
              <textarea
                aria-label={`Bundle note ${i + 1}`}
                value={note}
                onChange={(e) =>
                  change(
                    'notes',
                    (notes as string[]).map((n, j) => (i === j ? e.target.value : n)),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  change(
                    'notes',
                    (notes as string[]).filter((_, j) => i !== j),
                  )
                }
              >
                Remove note {i + 1}
              </button>
            </label>
          ))}
          <button
            type="button"
            onClick={() => change('notes', [...(Array.isArray(notes) ? notes : []), ''])}
          >
            Add note
          </button>
        </div>
        <div className="replica-actions">
          <button onClick={() => void save()} disabled={!draft || blocked}>
            Save changes
          </button>
          <button
            onClick={() => {
              setSaving(true)
              void clearDraft()
                .catch((reason: Error) => setError(reason.message))
                .finally(() => setSaving(false))
            }}
            disabled={!draft}
          >
            Discard draft
          </button>
        </div>
      </fieldset>
      <p role="status">{message}</p>
      {error && <p role="alert">{error}</p>}
      {FIELDS.map((field) => (
        <section key={field} aria-label={`${LABEL[field]} versions`}>
          {bundle.fields[field].candidates.length > 1 && (
            <>
              <h3>{LABEL[field]} conflict</h3>
              <p>All versions are preserved. Choose a value; other fields keep their changes.</p>
              {field === 'notes' && (
                <p>
                  This choice replaces the complete ordered notes list. It does not combine
                  individual notes.
                </p>
              )}
              {bundle.fields[field].candidates.map((candidate, i) => (
                <div className="replica-candidate" key={candidate.revisions.join(':')}>
                  <pre>{displayValue(candidate.value)}</pre>
                  <button
                    disabled={blocked || saving}
                    onClick={() =>
                      setReview({
                        field,
                        operation: crypto.randomUUID().replaceAll('-', ''),
                        value: candidate.value,
                        basis: [...bundle.fields[field].basis],
                      })
                    }
                  >
                    Choose {field} version {i + 1}
                  </button>
                </div>
              ))}
            </>
          )}
          <button
            onClick={() => {
              setHistoryField(field)
              setHistoryCursor('')
            }}
          >
            {LABEL[field]} history
          </button>
        </section>
      ))}
      {historyField && (
        <section aria-label="Retained versions">
          <h3>{LABEL[historyField]} history</h3>
          {history.isPending && <p>Loading retained versions…</p>}
          {history.error && <p role="alert">{history.error.message}</p>}
          {history.data?.items.map((item) => (
            <div className="replica-candidate" key={item.revision}>
              <pre>{displayValue(item.value)}</pre>
              <button
                disabled={blocked || saving}
                onClick={() =>
                  setReview({
                    field: historyField,
                    operation: crypto.randomUUID().replaceAll('-', ''),
                    value: item.value,
                    basis: [...bundle.fields[historyField].basis],
                  })
                }
              >
                Restore this value
              </button>
            </div>
          ))}
          {history.data?.next_cursor && (
            <button onClick={() => setHistoryCursor(history.data!.next_cursor!)}>
              More retained versions
            </button>
          )}
          <button onClick={() => setHistoryField(null)}>Close history</button>
        </section>
      )}
      {review && (
        <ReviewChoice onClose={() => setReview(null)}>
          <h3>Review {LABEL[review.field]} choice</h3>
          <pre>{displayValue(review.value)}</pre>
          <p>
            {review.field === 'notes'
              ? 'The whole ordered notes list will use this version.'
              : 'Only this field will change.'}{' '}
            Other fields and all retained versions remain available. Your unsaved draft stays in the
            editor.
          </p>
          {error && <p role="alert">{error}</p>}
          <button disabled={blocked || saving} onClick={() => void confirmReview()}>
            Confirm choice
          </button>
          <button disabled={saving} onClick={() => setReview(null)}>
            Cancel choice
          </button>
        </ReviewChoice>
      )}
      {localRecovery.length > 0 && (
        <section aria-label="Browser draft recovery">
          <h3>Other browser drafts</h3>
          {localRecovery.map((item, i) => (
            <div key={item.id}>
              <pre>
                {Object.entries(item.changes as Changes)
                  .map(
                    ([field, change]) =>
                      `${LABEL[field as FieldName]}: ${displayValue((change as Change).value)}`,
                  )
                  .join('\n')}
              </pre>
              <button disabled={Boolean(draft)} onClick={() => recover(item)}>
                Recover browser draft {i + 1}
              </button>
            </div>
          ))}
        </section>
      )}
      {drafts.error && <p role="alert">Private draft recovery: {drafts.error.message}</p>}
      {drafts.data && drafts.data.items.filter((item) => item.id !== draft?.id).length > 0 && (
        <section aria-label="Private draft recovery">
          <h3>Saved private drafts</h3>
          {draft && <p>Save or discard your current draft before recovering another.</p>}
          {drafts.data.items
            .filter((item) => item.id !== draft?.id)
            .map((item, i) => (
              <div key={item.id}>
                <span>Draft {i + 1}</span>
                <pre>
                  {Object.entries(item.changes as Changes)
                    .map(
                      ([field, change]) =>
                        `${LABEL[field as FieldName]}: ${displayValue((change as Change).value)}`,
                    )
                    .join('\n')}
                </pre>
                <button disabled={Boolean(draft)} onClick={() => recover(item)}>
                  Recover draft {i + 1}
                </button>
              </div>
            ))}
        </section>
      )}
      {drafts.data?.next_cursor && (
        <button onClick={() => setDraftCursor(drafts.data!.next_cursor!)}>
          More private drafts
        </button>
      )}
      {draftCursor && <button onClick={() => setDraftCursor('')}>First private drafts</button>}
    </article>
  )
}

// Native modal focus containment and Escape preserve keyboard access to conflict review
function ReviewChoice({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    ref.current?.showModal()
    return () => previous?.focus()
  }, [])
  return (
    <dialog
      ref={ref}
      className="replica-review"
      aria-label="Review metadata choice"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      {children}
    </dialog>
  )
}
