import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { CatalogJobError, operationId, runJob, type Entity, type Save } from '../api/catalog'
import { fileLockKey, withCatalogWriteLock } from '../api/catalogWriteQueue'
import { captureRequestScope } from '../api/requestScope'
import { useCatalogDraft } from './useCatalogDraft'

type Pending = { operation: string; request: Save; inputs: Record<string, string> }
type Acknowledged = Record<string, { event: string; value: string; bases: string[] }>
type Draft = {
  inputs: Record<string, string>
  observed: Record<string, string[]>
  parents: string[]
  pending: Pending | null
  acknowledged?: Acknowledged
}
const empty: Draft = { inputs: {}, observed: {}, parents: [], pending: null }

function decode(data: string, identity: string): Draft {
  const value = JSON.parse(data) as Draft
  const record = (input: unknown): input is Record<string, unknown> =>
    input !== null && typeof input === 'object' && !Array.isArray(input)
  const revisions = (input: unknown): input is string[] =>
    Array.isArray(input) && input.every((item) => typeof item === 'string')
  const cell = (unit: string, raw: unknown, guard = false): boolean => {
    if (!unit.startsWith(`asset_files/${identity}/`) || typeof raw !== 'string') return false
    const decoded: unknown = JSON.parse(raw)
    switch (unit.split('/')[2]) {
      case 'note':
      case 'source':
        return decoded === null || typeof decoded === 'string'
      case 'display_title':
        return guard && (decoded === null || typeof decoded === 'string')
      case 'cover_time':
        return guard && (decoded === null || typeof decoded === 'number')
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
    throw new Error('Invalid retained file metadata draft')
  if (
    value.acknowledged !== undefined &&
    (!record(value.acknowledged) ||
      !Object.entries(value.acknowledged).every(
        ([unit, saved]) =>
          record(saved) &&
          cell(unit, saved.value, true) &&
          typeof saved.event === 'string' &&
          saved.event.length > 0 &&
          revisions(saved.bases) &&
          saved.bases.every((basis) => revisions(JSON.parse(basis))),
      ))
  )
    throw new Error('Invalid retained save acknowledgement')
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
    throw new Error('Invalid retained file save request')
  return value
}

/**
 * Causal retained draft for `asset_files/{id}` (`note`, `source`, `$alive`),
 * keeping offline/debounced edits safe against silent overwrites on peer changes.
 */
export function useCatalogFileDraft(
  library: string,
  entity: Entity,
  editor: string,
  refresh: () => void,
  blocked = false,
) {
  const storage = useCatalogDraft(
    library,
    `file-inspector/${entity.id}`,
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
  const acknowledged = useRef<Acknowledged>(draft.acknowledged ?? {})

  function persist(next: Draft) {
    next = { ...next, acknowledged: acknowledged.current }
    latest.current = next
    storage.update({ data: JSON.stringify(next) })
  }

  function change(field: 'note' | 'source', raw: string) {
    const cell = entity.fields[field]
    if (!cell) return
    const current = latest.current
    const unit = cell.unit
    const continuing = Object.keys(current.inputs).length > 0 || current.pending !== null
    const bases = continuing ? current.observed : entity.observed
    const observed = { ...bases }
    if (!(unit in current.inputs)) observed[unit] = cell.basis
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
          ...Object.values(acknowledged.current).map((saved) => saved.event),
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
      await withCatalogWriteLock([fileLockKey(library, entity.id)], async () => {
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
        for (const changeItem of pending.request.changes) {
          const previous = acknowledged.current[changeItem.unit]
          acknowledged.current[changeItem.unit] = {
            event,
            value: changeItem.value,
            bases: [...new Set([...(previous?.bases ?? []), JSON.stringify(changeItem.basis)])],
          }
        }
        const next = latest.current
        const inputs = { ...next.inputs }
        const observed = { ...next.observed }
        for (const changeItem of pending.request.changes) {
          observed[changeItem.unit] = [event]
          if (inputs[changeItem.unit] === pending.inputs[changeItem.unit])
            delete inputs[changeItem.unit]
        }
        persist({
          inputs,
          observed,
          parents: [...new Set([...next.parents, event])],
          pending: null,
        })
        saved = true
        setMessage(Object.keys(inputs).length ? 'Saving…' : 'Saved')
        refresh()
      })
    } catch (reason) {
      if (!storage.isCurrent()) return
      if (reason instanceof CatalogJobError) persist({ ...latest.current, pending: null })
      setMessage('')
      setError((reason as Error).message)
    } finally {
      running.current = false
      setBusy(false)
      if (saved && Object.keys(latest.current.inputs).length) void save()
    }
  }

  function acceptResolution(
    values: Record<string, string>,
    bases: Record<string, string[]>,
    event: string,
  ) {
    if (!storage.isCurrent() || running.current || latest.current.pending) return
    const next = latest.current
    const inputs = { ...next.inputs }
    const observed = { ...next.observed }
    for (const [unit, value] of Object.entries(values)) {
      if (!unit.startsWith(`asset_files/${entity.id}/`)) continue
      const field = unit.split('/')[2]
      if (!field || !['note', 'source', 'display_title', 'cover_time', '$alive'].includes(field))
        continue
      acknowledged.current[unit] = {
        event,
        value,
        bases: [
          ...new Set([...(acknowledged.current[unit]?.bases ?? []), JSON.stringify(bases[unit])]),
        ],
      }
      delete inputs[unit]
      observed[unit] = [event]
    }
    persist({ ...next, inputs, observed, parents: [...new Set([...next.parents, event])] })
    setError('')
    setMessage(Object.keys(inputs).length ? 'Saving…' : 'Saved')
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
    acceptResolution,
    busy,
    error: error || (dirty ? storage.error : ''),
    message,
    read: (field: 'note' | 'source') => {
      const cell = entity.fields[field]
      if (!cell) return 'null'
      const saved = acknowledged.current[cell.unit]
      const value =
        saved && saved.bases.includes(JSON.stringify(cell.basis)) ? saved.value : cell.value
      return draft.inputs[cell.unit] ?? value ?? 'null'
    },
  }
}
