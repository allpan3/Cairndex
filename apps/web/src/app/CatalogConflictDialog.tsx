// A bundle's competing edits, resolved in place with the causal choose → commit_preview protocol
import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { catalog, CatalogJobError, entityLabel, operationId, runJob } from '../api/catalog'
import type { Entity, Field } from '../api/catalog'
import { fileThumbnailUrl } from '../api/client'
import { captureRequestScope } from '../api/requestScope'
import { formatRating } from './rating'
import { useModalDialog } from './useModalDialog'

/** Bundle fields this dialog can show as readable values. Anything else is structural. */
const ORDINARY: Record<string, string> = {
  title: 'Title',
  rating: 'Rating',
  notes: 'Notes',
  cover_file_id: 'Cover',
  primary_file_id: 'Main file',
}
const STRUCTURAL: Record<string, string> = {
  $alive: 'Whether this bundle exists',
  $members: 'Files and their order',
}

export type ConflictGroup = {
  /** The held unit the choice is anchored on. */
  unit: string
  bundle: string
  bundleTitle: string
  /** Every unit in the server's structural scope, with the bases shown to the owner. */
  fields: Field[]
  /** Labels of the bundle's held fields in this scope, for a structural summary. */
  labels: string[]
  ordinary: boolean
}

const fieldName = (unit: string) => unit.split('/')[2] ?? ''
const fieldLabel = (unit: string) => {
  const name = fieldName(unit)
  return ORDINARY[name] ?? STRUCTURAL[name] ?? name.replace(/^\$/, '').replaceAll('_', ' ')
}

/** Every distinct value the owner may keep: the shown value, then each retained branch. */
function conflictOptions(field: Field): string[] {
  return [
    ...new Set([
      ...(field.value === null ? [] : [field.value]),
      ...field.candidates.map((candidate) => candidate.value),
    ]),
  ]
}

/** A unit with one branch keeps its shown value; competing units need the owner's choice. */
function settledValue(field: Field): string | undefined {
  return field.candidates.length === 1 ? (field.value ?? undefined) : undefined
}

/** The exact choose request for one scope: each unit's choice and the bases that were shown. */
function chooseRequest(group: ConflictGroup, choices: Record<string, string>) {
  const selected = group.fields.map((field): [string, string | undefined] => [
    field.unit,
    choices[field.unit] ?? settledValue(field),
  ])
  if (selected.some(([, value]) => value === undefined)) return null
  return {
    action: 'choose',
    unit: group.unit,
    recover: false,
    choices: Object.fromEntries(selected) as Record<string, string>,
    observed: Object.fromEntries(group.fields.map((field) => [field.unit, field.basis])),
  }
}

/**
 * Read each bundle's held fields and the complete scope a choice must cover.
 * One read is the snapshot the owner reviews: its bases are what a choice sends,
 * so a later change on the server makes the choice stale instead of silently
 * widening it.
 */
async function loadConflicts(library: string, bundles: string[]): Promise<ConflictGroup[]> {
  const owners = new Map<string, Promise<Entity>>()
  const owner = (path: string) => {
    if (!owners.has(path)) owners.set(path, catalog<Entity>(library, `/entities/${path}`))
    return owners.get(path)!
  }
  const groups: ConflictGroup[] = []
  const covered = new Set<string>()
  for (const bundle of bundles.filter(Boolean)) {
    const entity = await owner(`asset_bundles/${bundle}`)
    const held = Object.values(entity.fields)
      .filter((field) => field.held)
      .sort((a, b) => a.unit.localeCompare(b.unit))
    for (const field of held) {
      if (covered.has(field.unit)) continue
      const history = await catalog<{ scope: string[] }>(
        library,
        `/history?unit=${encodeURIComponent(field.unit)}`,
      )
      for (const unit of history.scope) covered.add(unit)
      const fields = await Promise.all(
        history.scope.map(async (unit) => {
          const [family, id] = unit.split('/')
          return (await owner(`${family}/${id}`)).fields[fieldName(unit)]
        }),
      )
      const complete = fields.every(Boolean)
      const own = held.filter((item) => history.scope.includes(item.unit))
      groups.push({
        unit: field.unit,
        bundle,
        bundleTitle: entityLabel(entity) === entity.id ? 'Untitled bundle' : entityLabel(entity),
        fields: fields.filter((item): item is Field => Boolean(item)),
        labels: own.map((item) => fieldLabel(item.unit)),
        ordinary:
          complete &&
          fields.every(
            (item) =>
              item!.unit.startsWith(`asset_bundles/${bundle}/`) &&
              fieldName(item!.unit) in ORDINARY &&
              (settledValue(item!) !== undefined || conflictOptions(item!).length > 0),
          ) &&
          fields.some((item) => settledValue(item!) === undefined),
      })
    }
  }
  return groups
}

const related = (count: number) =>
  count > 0 ? `, together with ${count} related ${count === 1 ? 'value' : 'values'}` : ''

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

// Notes are a JSON list stored as JSON text; malformed history stays verbatim
function noteList(raw: string): string[] {
  const outer = parse(raw)
  const inner = typeof outer === 'string' ? parse(outer) : outer
  if (inner === null) return []
  if (Array.isArray(inner)) return inner.map(String).filter((note) => note.trim())
  return [String(inner)]
}

/** One alternative as the owner sees it in the inspector, never as stored JSON. */
export function ConflictValue({
  bundle,
  unit,
  raw,
  name,
}: {
  bundle: string
  unit: string
  raw: string
  /** The accessible name of a value that has no text, such as a cover. */
  name: string
}) {
  const [failed, setFailed] = useState(false)
  const value = parse(raw)
  const empty = (text: string) => <span className="conflict-review__empty">{text}</span>
  switch (fieldName(unit)) {
    case 'rating':
      return typeof value === 'number' && value > 0 ? (
        <span className="conflict-review__rating">
          <span className="conflict-review__stars" aria-hidden="true">
            {'★'.repeat(Math.floor(value))}
          </span>{' '}
          <span>{formatRating(value)}</span>
        </span>
      ) : (
        empty('No rating')
      )
    case 'notes': {
      const notes = noteList(raw)
      return notes.length ? (
        <ol className="conflict-review__notes">
          {notes.map((note, index) => (
            <li key={index}>{note}</li>
          ))}
        </ol>
      ) : (
        empty('No notes')
      )
    }
    case 'cover_file_id':
    case 'primary_file_id':
      if (typeof value !== 'string')
        return empty(fieldName(unit) === 'cover_file_id' ? 'Default cover' : 'No main file')
      return failed ? (
        empty('Preview unavailable on this device')
      ) : (
        <img
          className="conflict-review__thumb"
          src={fileThumbnailUrl(bundle, value, value)}
          alt={name}
          onError={() => setFailed(true)}
        />
      )
    default:
      return typeof value === 'string' && value ? (
        <span className="conflict-review__text">{value}</span>
      ) : (
        empty('No title')
      )
  }
}

/**
 * Review and resolve the conflicts of the given bundles without leaving the browser.
 * Ordinary fields resolve here; structural scopes (files, order, existence, or
 * anything spanning other objects) are summarized and sent to Metadata Review,
 * which shows their complete affected scope and recovery safeguards.
 */
export function CatalogConflictDialog({
  library,
  bundles,
  blocked,
  onClose,
  onResolved,
  onAdvanced,
}: {
  library: string
  bundles: string[]
  blocked: boolean
  onClose: () => void
  /** Called after a choice is committed, so the caller can refresh its views. */
  onResolved: (
    values: Record<string, string>,
    observed: Record<string, string[]>,
    event: string,
  ) => void
  /** Open the full review for a structural scope. */
  onAdvanced: (unit: string) => void
}) {
  const titleId = useId()
  const [busy, setBusy] = useState(false)
  const { ref, close } = useModalDialog(onClose, busy)
  const [generation, setGeneration] = useState(0)
  const [loaded, setLoaded] = useState<{ generation: number; groups: ConflictGroup[] } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  // One retry identity per exact intent: a lost reply retries the same operation
  const operations = useRef(new Map<string, string>())
  const key = bundles.join(',')

  useEffect(() => {
    let current = true
    loadConflicts(library, key.split(','))
      .then((groups) => {
        if (!current) return
        setLoaded({ generation, groups })
        setLoadError('')
        // Keep a choice only while the reloaded scope still offers it
        setChoices((previous) =>
          Object.fromEntries(
            Object.entries(previous).filter(([unit, raw]) =>
              groups.some((group) =>
                group.fields.some(
                  (field) => field.unit === unit && conflictOptions(field).includes(raw),
                ),
              ),
            ),
          ),
        )
      })
      .catch((reason: Error) => {
        if (current) setLoadError(reason.message)
      })
    return () => {
      current = false
    }
  }, [library, key, generation])

  // Versions arrive after the dialog opens; move focus from the close button to the first one
  const focused = useRef(false)
  useEffect(() => {
    const root = ref.current
    if (!loaded || focused.current || !root) return
    focused.current = true
    const active = document.activeElement
    if (active === root || active?.classList.contains('modal__close'))
      root.querySelector<HTMLElement>('input[type="radio"], .conflict-review__body button')?.focus()
  }, [loaded, ref])

  const groups = loaded?.groups ?? []
  const ordinary = groups.filter((group) => group.ordinary)
  const structural = groups.filter((group) => !group.ordinary)
  const requests = ordinary.map((group) => chooseRequest(group, choices))
  const ready = ordinary.length > 0 && requests.every(Boolean)
  const loading = !loaded || loaded.generation !== generation
  const several = new Set(groups.map((group) => group.bundle)).size > 1

  async function apply() {
    if (!ready || busy || blocked || loading) return
    const scope = captureRequestScope()
    let intent = ''
    setBusy(true)
    setError('')
    try {
      for (const request of requests) {
        intent = JSON.stringify(request)
        const operation = operations.current.get(intent) ?? operationId()
        operations.current.set(intent, operation)
        const prepared = await runJob(library, 'preview', request, operation)
        const committed = await runJob(
          library,
          'commit_preview',
          { job: prepared.id, receipt: prepared.receipt },
          `commit_${prepared.id}`,
        )
        scope()
        const event = committed.result?.event
        if (!event) throw new Error('The save receipt is unavailable. Try again.')
        const changes = prepared.result?.changes
        onResolved(
          changes
            ? Object.fromEntries(changes.map((change) => [change.unit, change.value]))
            : request!.choices,
          changes
            ? Object.fromEntries(changes.map((change) => [change.unit, change.basis]))
            : request!.observed,
          event,
        )
      }
      scope()
      if (!structural.length) onClose()
      else setGeneration((value) => value + 1)
    } catch (reason) {
      try {
        scope()
      } catch {
        return
      }
      const message = (reason as Error).message
      // The server refused this intent, so a retry must be a new operation
      if (reason instanceof CatalogJobError) operations.current.delete(intent)
      if (reason instanceof CatalogJobError && /stale/i.test(message)) {
        setError('These versions changed while this was open. The latest versions are shown.')
        setGeneration((value) => value + 1)
      } else setError(message || 'The choice could not be saved. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="modal-backdrop conflict-review" onMouseDown={close}>
      <div
        className="modal conflict-review__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal__head">
          <h2 id={titleId}>Conflicting Edits</h2>
          <button className="modal__close" aria-label="Close" disabled={busy} onClick={close}>
            ×
          </button>
        </div>
        <p className="modal__sub">
          These edits were made separately and could not be combined. Choose the version to keep.
          The other versions stay in history.
        </p>
        <div className="conflict-review__body">
          {loadError && (
            <p role="alert" className="modal__error">
              Conflicts could not be loaded. {loadError}{' '}
              <button className="btn btn--compact" onClick={() => setGeneration((v) => v + 1)}>
                Try Again
              </button>
            </p>
          )}
          {!loaded && !loadError && <p role="status">Loading versions…</p>}
          {loaded && !groups.length && (
            <p role="status">No conflicts remain. Every edit is combined.</p>
          )}
          {groups.map((group) => (
            <section key={group.unit} className="conflict-review__group">
              {several && <h3 className="conflict-review__bundle">{group.bundleTitle}</h3>}
              {group.ordinary ? (
                group.fields
                  .filter((field) => settledValue(field) === undefined)
                  .map((field) => (
                    <fieldset key={field.unit} className="conflict-review__field" disabled={busy}>
                      <legend>{fieldLabel(field.unit)}</legend>
                      {conflictOptions(field).map((raw, index) => (
                        <label
                          key={raw}
                          className={`conflict-review__option${
                            choices[field.unit] === raw ? ' is-selected' : ''
                          }`}
                        >
                          <input
                            type="radio"
                            name={field.unit}
                            checked={choices[field.unit] === raw}
                            onChange={() => setChoices({ ...choices, [field.unit]: raw })}
                          />
                          <span className="conflict-review__value">
                            <ConflictValue
                              bundle={group.bundle}
                              unit={field.unit}
                              raw={raw}
                              name={`${fieldLabel(field.unit)} version ${index + 1}`}
                            />
                          </span>
                          {raw === field.value && (
                            <span className="conflict-review__tag">Shown now</span>
                          )}
                        </label>
                      ))}
                    </fieldset>
                  ))
              ) : (
                <div className="conflict-review__structural">
                  <p>
                    <strong>{group.labels.join(', ') || 'Related items'}</strong> changed in more
                    than one place{related(group.fields.length - 1)}. Metadata Review shows
                    everything affected before anything changes.
                  </p>
                  <button
                    className="btn btn--compact"
                    disabled={busy}
                    onClick={() => onAdvanced(group.unit)}
                  >
                    Open Full Review…
                  </button>
                </div>
              )}
            </section>
          ))}
        </div>
        {error && (
          <p role="alert" className="modal__error">
            {error}
          </p>
        )}
        <div className="modal__actions">
          <button className="btn" disabled={busy} onClick={close}>
            Cancel
          </button>
          {ordinary.length > 0 && (
            <button
              className="btn btn--primary"
              disabled={!ready || busy || blocked || loading}
              onClick={() => void apply()}
            >
              {busy ? 'Saving…' : 'Keep Selected'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
