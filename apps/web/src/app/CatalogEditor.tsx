// Durable family editors retain exact authored input and mandatory observed bases
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  advancedCatalogFields,
  catalog,
  displayCell,
  entityLabel,
  operationId,
  runJob,
  type Control,
  type Entity,
  type Job,
  type Save,
} from '../api/catalog'
import { draftKey } from '../api/replicas'
import { CatalogValue } from './CatalogControls'
import { CatalogArrangement, CatalogComposite } from './CatalogStructures'
import { CatalogHistory, CatalogReview } from './CatalogReview'
import { useCatalogDraft } from './useCatalogDraft'

type Draft = {
  id: string
  revision: number
  inputs: Record<string, string>
  observed: Record<string, string[]>
  parents: string[]
  operation: string
}

// Local durable text complements the server draft while disconnected
function stored(key: string): Draft | null {
  const raw = localStorage.getItem(key)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  if (!validDraft(value)) throw new Error('Invalid draft schema')
  return value
}

// Validate persisted envelopes before reading inputs or bases from browser or server storage
function validDraft(value: unknown): value is Draft {
  if (!value || typeof value !== 'object') return false
  const draft = value as Partial<Draft>
  const record = (item: unknown): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
  return (
    typeof draft.id === 'string' &&
    /^[A-Za-z0-9_-]{1,64}$/.test(draft.id) &&
    Number.isInteger(draft.revision) &&
    draft.revision! > 0 &&
    typeof draft.operation === 'string' &&
    record(draft.inputs) &&
    Object.values(draft.inputs).every((cell) => typeof cell === 'string') &&
    record(draft.observed) &&
    Object.values(draft.observed).every(
      (basis) => Array.isArray(basis) && basis.every((id) => typeof id === 'string'),
    ) &&
    Array.isArray(draft.parents) &&
    draft.parents.every((id) => typeof id === 'string')
  )
}

// Only references involved in the current fields receive lifetime touches
function guards(entity: Entity, inputs: Record<string, string>): string[] {
  const result = new Set([`${entity.family}/${entity.id}/$alive`])
  for (const [unit, raw] of Object.entries(inputs)) {
    const field = unit.split('/')[2]!
    if (['cover_file_id', 'primary_file_id', 'cover_bundle_id'].includes(field) && raw !== 'null')
      result.add(
        `${field === 'cover_bundle_id' ? 'asset_bundles' : 'asset_files'}/${JSON.parse(raw)}/$alive`,
      )
    if (['$span', '$source'].includes(field)) {
      const parts = JSON.parse(raw) as Record<string, unknown>
      for (const [column, value] of Object.entries(parts))
        if (value && (column === 'bundle_id' || column.endsWith('file_id')))
          result.add(
            `${column === 'bundle_id' ? 'asset_bundles' : 'asset_files'}/${String(value)}/$alive`,
          )
    }
  }
  if (entity.id.includes('~'))
    for (const unit of Object.keys(entity.observed)) if (unit.endsWith('/$alive')) result.add(unit)
  return [...result]
}

// Each editor owns its drafts and operation IDs independently of other tabs
export function CatalogEditor({
  library,
  entity,
  editor,
  blocked,
  refresh,
}: {
  library: string
  entity: Entity
  editor: string
  blocked: boolean
  refresh: () => void
}) {
  const owner = `${entity.family}/${entity.id}`
  const key = draftKey(library, owner, editor)
  const [draft, setDraft] = useState<Draft | null>(() => {
    try {
      return stored(key)
    } catch {
      return null
    }
  })
  const [error, setError] = useState(() => {
    try {
      stored(key)
      return ''
    } catch {
      return 'The browser draft could not be read. Its stored bytes are retained.'
    }
  })
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [prepared, setPrepared] = useState<Job | null>(null)
  const previewDraft = useCatalogDraft(library, `preview/${owner}`, editor, { job: '' })
  useEffect(() => {
    if (previewDraft.body.job)
      void catalog<Job>(library, `/jobs/${previewDraft.body.job}`)
        .then(setPrepared)
        .catch((reason: Error) => setError(reason.message))
  }, [library, previewDraft.body.job])
  const [review, setReview] = useState<string | null>(null)
  const [history, setHistory] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const controls = useQuery({
    queryKey: ['catalog-controls', library, entity.family],
    queryFn: () => catalog<Control[]>(library, `/controls/${entity.family}`),
  })
  const drafts = useQuery({
    queryKey: ['catalog-drafts', library, owner],
    queryFn: () =>
      catalog<{ items: { id: string; revision: number; body: Draft }[] }>(
        library,
        `/drafts?owner=${encodeURIComponent(owner)}`,
      ),
    refetchInterval: 4000,
  })

  // Persist every generation before starting a save; delayed writes are fenced by receipts
  function persist(next: Draft) {
    try {
      try {
        stored(key)
      } catch {
        if (!localStorage.getItem(`${key}.unreadable`))
          localStorage.setItem(`${key}.unreadable`, localStorage.getItem(key) ?? '')
      }
      localStorage.setItem(key, JSON.stringify(next))
    } catch {
      setError('Browser storage is unavailable; server draft delivery is pending.')
    }
    setDraft(next)
    void catalog(library, `/drafts/${owner}/${next.id}`, 'PUT', {
      revision: next.revision,
      body: next,
    }).catch((reason: Error) => setError(reason.message))
  }
  // Retain original field bases while newly selected references add their own guards
  function change(unit: string, raw: string, observed: Record<string, string[]> = {}) {
    const next: Draft = {
      id: draft?.id ?? operationId(),
      revision: (draft?.revision ?? 0) + 1,
      inputs: { ...draft?.inputs, [unit]: raw },
      observed: { ...entity.observed, ...observed, ...draft?.observed },
      parents: draft?.parents ?? entity.parents,
      operation: operationId(),
    }
    setMessage('Private draft retained')
    persist(next)
  }
  // Acknowledged generations cannot be revived by delayed background writes
  async function clear(current: Draft) {
    await catalog(library, `/drafts/${current.id}?revision=${current.revision}`, 'DELETE')
    localStorage.removeItem(key)
    setDraft(null)
    void drafts.refetch()
  }
  // Save the exact draft intent and keep its retry identity until acknowledgement
  async function save() {
    if (!draft) return
    setBusy(true)
    setError('')
    try {
      const values = { ...draft.inputs }
      for (const guard of guards(entity, values)) values[guard] ??= 'true'
      const request: Save = {
        changes: Object.entries(values).map(([unit, value]) => {
          if (!draft.observed[unit])
            throw new Error(
              'Open the referenced object to obtain its observed basis before saving.',
            )
          return { unit, value, basis: draft.observed[unit]! }
        }),
        parents: draft.parents,
        resolve: false,
        recover: false,
      }
      await runJob(library, 'save', request, draft.operation)
      await clear(draft)
      setMessage('Saved here')
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Record queued preview identity before awaiting a potentially interrupted response
  async function preview(body: unknown, action = 'preview') {
    setBusy(true)
    setError('')
    setPrepared(null)
    try {
      const operation = operationId()
      previewDraft.update({ job: operation })
      const result = await runJob(library, action, body, operation)
      setPrepared(result)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Commit the reviewed receipt with a deterministic retry identity
  async function commitPreview() {
    if (!prepared) return
    setBusy(true)
    setError('')
    try {
      await runJob(
        library,
        'commit_preview',
        { job: prepared.id, receipt: prepared.receipt },
        `commit_${prepared.id}`,
      )
      await previewDraft.discard()
      setPrepared(null)
      setReview(null)
      setMessage('Saved here')
      refresh()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  // Recover a server draft into this editor without deleting the original editor's copy
  function recoverDraft(body: Draft) {
    persist({ ...body, id: operationId(), revision: 1, operation: operationId() })
  }
  useEffect(() => {
    if (!draft) return
    const deliver = () =>
      void catalog(library, `/drafts/${owner}/${draft.id}`, 'PUT', {
        revision: draft.revision,
        body: draft,
      }).catch((reason: Error) => setError(reason.message))
    deliver()
    const timer = setInterval(deliver, 4000)
    return () => clearInterval(timer)
  }, [library, owner, draft])
  const shown =
    entity.id === '_'
      ? [
          {
            field: '$forest',
            label: 'Hierarchy',
            kind: 'structure',
            columns: [],
            nullable: false,
            choices: [],
            reference_family: null,
          },
        ]
      : (controls.data ?? [])
  return (
    <section className="replica-editor" aria-label="Catalog editor">
      <h2>{entityLabel(entity)}</h2>
      <p>{owner}</p>
      <p role="status">{message}</p>
      {error && <p role="alert">{error}</p>}
      {previewDraft.error && <p role="alert">{previewDraft.error}</p>}
      {controls.error && <p role="alert">{controls.error.message}</p>}
      <label>
        <input
          type="checkbox"
          checked={advanced}
          onChange={(event) => setAdvanced(event.target.checked)}
        />
        Show provenance and exact metadata
      </label>
      {shown
        .filter((control) => advanced || !advancedCatalogFields.has(control.field))
        .map((control) => {
          const field = entity.fields[control.field]
          if (!field) return null
          const raw = draft?.inputs[field.unit] ?? field.value ?? 'null'
          return (
            <fieldset key={control.field} disabled={busy}>
              <legend>{control.label}</legend>
              {control.kind === 'lifetime' ? (
                <p>{displayCell(field.value)}</p>
              ) : ['$members', '$forest'].includes(control.field) ? (
                <CatalogArrangement
                  library={library}
                  entity={entity}
                  field={field}
                  onPreview={(body) => void preview(body)}
                />
              ) : control.kind === 'structure' ? (
                <CatalogComposite
                  key={`${field.unit}:${draft?.id ?? field.value}`}
                  library={library}
                  field={field}
                  control={control}
                  raw={raw}
                  onChange={(next, bases) => change(field.unit, next, bases)}
                />
              ) : (
                <CatalogValue
                  library={library}
                  control={control}
                  raw={raw}
                  onChange={(next, bases) => change(field.unit, next, bases)}
                />
              )}
              {field.held && (
                <p role="alert">Conflicting metadata or arrangement requires review.</p>
              )}
              {field.held && (
                <button onClick={() => setReview(field.unit)}>Review {control.label}</button>
              )}
              <button onClick={() => setHistory(control.field)}>History of {control.label}</button>
            </fieldset>
          )
        })}
      <button disabled={busy || blocked || !draft} onClick={() => void save()}>
        Save catalog changes
      </button>
      {draft && (
        <button disabled={busy} onClick={() => void clear(draft)}>
          Discard this draft
        </button>
      )}
      {entity.id !== '_' && (
        <button
          disabled={busy || blocked}
          onClick={() =>
            void preview({ action: 'delete', family: entity.family, entity: entity.id })
          }
        >
          Prepare metadata deletion
        </button>
      )}
      {drafts.data?.items
        .filter((item) => validDraft(item.body) && item.id !== draft?.id)
        .map((item) => (
          <button key={item.id} onClick={() => recoverDraft(item.body)}>
            Recover private draft {item.revision}
          </button>
        ))}
      {previewDraft.copies.map((copy) => (
        <button key={copy.id} onClick={() => previewDraft.update(copy.body)}>
          Recover prepared operation {copy.revision}
        </button>
      ))}
      {review && (
        <CatalogReview
          key={review}
          library={library}
          editor={editor}
          unit={review}
          onPreview={(body, action) => void preview(body, action)}
          onClose={() => setReview(null)}
        />
      )}
      {history && entity.fields[history] && (
        <CatalogHistory
          library={library}
          entity={entity}
          field={entity.fields[history]!}
          onUse={(raw) => {
            change(entity.fields[history]!.unit, raw)
            setHistory(null)
          }}
          onPreview={(body, action) => void preview(body, action)}
          onClose={() => setHistory(null)}
        />
      )}
      {prepared?.result && (
        <section aria-label="Prepared catalog operation">
          <h3>Review complete operation</h3>
          <p>All shown changes are applied together. Physical files remain in place.</p>
          {prepared.result.changes.map((change) => (
            <div key={change.unit}>
              <strong>{change.unit}</strong>
              <p className="catalog-exact">{displayCell(change.value)}</p>
            </div>
          ))}
          <button disabled={busy || blocked} onClick={() => void commitPreview()}>
            Apply reviewed operation
          </button>
          <button onClick={() => setPrepared(null)}>Close preview</button>
        </section>
      )}
    </section>
  )
}
