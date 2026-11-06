import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { CatalogJobError, operationId, runJob, type Entity, type Save } from '../api/catalog'
import { captureRequestScope } from '../api/requestScope'
import { useCatalogDraft } from './useCatalogDraft'

type Pending = { operation: string; request: Save; inputs: Record<string, string> }
type Draft = {
  inputs: Record<string, string>
  observed: Record<string, string[]>
  parents: string[]
  pending: Pending | null
}
const empty: Draft = { inputs: {}, observed: {}, parents: [], pending: null }
function decode(data: string, identity: string): Draft {
  const value = JSON.parse(data) as Draft
  const record = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
  const revisions = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((item) => typeof item === 'string')
  const cell = (unit: string, raw: unknown, guard = false): boolean => {
    if (guard && /^asset_files\/[A-Za-z0-9_-]+\/\$alive$/.test(unit)) return raw === 'true'
    if (!unit.startsWith(`asset_bundles/${identity}/`) || typeof raw !== 'string') return false
    const decoded: unknown = JSON.parse(raw)
    switch (unit.split('/')[2]) {
      case 'title':
      case 'cover_file_id':
        return decoded === null || typeof decoded === 'string'
      case 'rating':
        return (
          decoded === null ||
          (typeof decoded === 'number' && Number.isFinite(decoded) && decoded >= 0 && decoded <= 5)
        )
      case 'notes': {
        if (decoded === null) return true
        if (typeof decoded !== 'string') return false
        const notes: unknown = JSON.parse(decoded)
        return (
          notes === null ||
          (Array.isArray(notes) && notes.every((note) => typeof note === 'string'))
        )
      }
      case '$alive':
        return guard && decoded === true
      default:
        return false
    }
  }
  if (
    !record(value) ||
    !record(value.inputs) ||
    !record(value.observed) ||
    !Object.values(value.observed).every(revisions) ||
    !revisions(value.parents) ||
    !Object.entries(value.inputs).every(
      ([unit, raw]) => cell(unit, raw) && value.observed[unit]?.length,
    )
  )
    throw new Error('Invalid retained metadata draft')
  const pending = value.pending
  if (
    pending !== null &&
    (!record(pending) ||
      typeof pending.operation !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(pending.operation) ||
      !record(pending.inputs) ||
      !Object.entries(pending.inputs).every(([unit, raw]) => cell(unit, raw)) ||
      !record(pending.request) ||
      !revisions(pending.request.parents) ||
      pending.request.resolve !== false ||
      pending.request.recover !== false ||
      !Array.isArray(pending.request.changes) ||
      !pending.request.changes.length ||
      !pending.request.changes.every(
        (change) =>
          record(change) &&
          typeof change.unit === 'string' &&
          cell(change.unit, change.value, true) &&
          revisions(change.basis) &&
          change.basis.length,
      ))
  )
    throw new Error('Invalid retained save request')
  return value
}

// A retained pending request survives response loss and cannot change when typing continues.
export function useCatalogBundleDraft(
  library: string,
  entity: Entity,
  editor: string,
  refresh: () => void,
  blocked = false,
) {
  const storage = useCatalogDraft(
    library,
    `inspector/${entity.id}`,
    editor,
    { data: JSON.stringify(empty) },
    (body) => {
      try {
        decode(body.data, entity.id)
        return true
      } catch {
        return false
      }
    },
    false,
  )
  const draft = decode(storage.body.data, entity.id)
  const latest = useRef(draft)
  const scope = useRef(captureRequestScope())
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const acknowledged = useRef<Record<string, { event: string; value: string; bases: string[] }>>({})
  const acknowledgedEvent = useRef('')
  function persist(next: Draft) {
    latest.current = next
    storage.update({ data: JSON.stringify(next) })
  }
  function change(field: string, raw: string, references: Entity[] = []) {
    const current = latest.current
    const unit = entity.fields[field]!.unit
    const continuing = Object.keys(current.inputs).length > 0 || current.pending !== null
    const bases = continuing ? current.observed : entity.observed
    const observed = { ...bases }
    if (!(unit in current.inputs)) observed[unit] = entity.fields[field]!.basis
    for (const reference of references) {
      const alive = reference.fields.$alive!
      if (alive.value !== 'true' || alive.held) {
        setError('The selected file is unavailable or requires metadata review.')
        return
      }
      observed[alive.unit] = alive.basis
    }
    for (const [savedUnit, saved] of Object.entries(acknowledged.current)) {
      if (saved.bases.includes(JSON.stringify(entity.observed[savedUnit])))
        observed[savedUnit] = [saved.event]
    }
    persist({
      ...current,
      inputs: { ...current.inputs, [unit]: raw },
      observed,
      parents: [
        ...new Set([
          ...(continuing ? current.parents : entity.parents),
          ...references.flatMap((reference) => reference.parents),
          ...(acknowledgedEvent.current ? [acknowledgedEvent.current] : []),
        ]),
      ],
    })
    setError('')
    setMessage('Saving…')
  }
  async function save() {
    if (running.current || blocked || !storage.isCurrent()) return
    if (!latest.current.pending && !Object.keys(latest.current.inputs).length) return
    running.current = true
    setBusy(true)
    setError('')
    let saved = false
    try {
      scope.current()
      let current = latest.current
      if (!current.pending && !Object.keys(current.inputs).length) return
      if (!current.pending) {
        const reviewedConflict = Object.values(entity.fields).some(
          (field) =>
            field.held &&
            (field.unit in current.inputs || field.unit.endsWith('/$alive')) &&
            field.basis.every((revision) => current.observed[field.unit]?.includes(revision)),
        )
        if (reviewedConflict)
          throw new Error('Review the competing values before replacing this metadata.')
        const alive = entity.fields.$alive!.unit
        const values = { ...current.inputs, [alive]: 'true' }
        const cover = values[`asset_bundles/${entity.id}/cover_file_id`]
        if (cover && cover !== 'null') {
          const reference = `asset_files/${JSON.parse(cover)}/$alive`
          if (!current.observed[reference]?.length)
            throw new Error('Select the cover file again to read its current metadata.')
          values[reference] = 'true'
        }
        const request: Save = {
          changes: Object.entries(values).map(([unit, value]) => ({
            unit,
            value,
            basis: current.observed[unit]!,
          })),
          parents: current.parents,
          resolve: false,
          recover: false,
        }
        current = {
          ...current,
          pending: { operation: operationId(), request, inputs: current.inputs },
        }
        persist(current)
      }
      const pending = current.pending!
      const job = await runJob(library, 'save', pending.request, pending.operation)
      const event = job.result?.event
      if (!event) throw new Error('The save receipt is unavailable. Retry the retained request.')
      if (!storage.isCurrent()) return
      acknowledgedEvent.current = event
      for (const change of pending.request.changes) {
        const previous = acknowledged.current[change.unit]
        acknowledged.current[change.unit] = {
          event,
          value: change.value,
          // Polling can lag more than one autosave. Recognize every superseded
          // own basis, while keeping a genuinely new peer basis untouched.
          bases: [...new Set([...(previous?.bases ?? []), JSON.stringify(change.basis)])],
        }
      }
      const next = latest.current
      const inputs = { ...next.inputs }
      const observed = { ...next.observed }
      for (const change of pending.request.changes) {
        observed[change.unit] = [event]
        if (inputs[change.unit] === pending.inputs[change.unit]) delete inputs[change.unit]
      }
      // Advance only this save's units. A refresh must not advance other draft bases.
      persist({ inputs, observed, parents: [...new Set([...next.parents, event])], pending: null })
      saved = true
      setMessage(Object.keys(inputs).length ? 'Saving…' : 'Saved')
      refresh()
    } catch (reason) {
      if (!storage.isCurrent()) return
      if (reason instanceof CatalogJobError) persist({ ...latest.current, pending: null })
      setMessage('')
      setError((reason as Error).message)
    } finally {
      running.current = false
      setBusy(false)
      // Drain edits made during a save even when navigation unmounted this view.
      if (saved && Object.keys(latest.current.inputs).length) void save()
    }
  }
  const autoSave = useEffectEvent(() => {
    if (!blocked && (!error || latest.current.pending)) void save()
  })
  const pending = Boolean(draft.pending)
  const dirty = pending || Object.keys(draft.inputs).length > 0
  useEffect(() => {
    if (!dirty || busy || blocked || (error && !pending)) return
    const timer = setTimeout(autoSave, error ? 5000 : 400)
    return () => clearTimeout(timer)
  }, [storage.body.data, dirty, busy, blocked, error, pending])
  useEffect(() => () => autoSave(), [])

  return {
    draft,
    change,
    save,
    busy,
    error: error || (dirty ? storage.error : ''),
    message,
    read: (field: string) => {
      const cell = entity.fields[field]!
      const saved = acknowledged.current[cell.unit]
      const value =
        saved && saved.bases.includes(JSON.stringify(cell.basis)) ? saved.value : cell.value
      return draft.inputs[cell.unit] ?? value ?? 'null'
    },
  }
}
