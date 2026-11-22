// Focused structural, lifetime and membership conflict review for a single browser item
import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  catalog,
  displayCell,
  entityLabel,
  FAMILIES,
  operationId,
  runJob,
  type Entity,
  type Field,
  type Job,
} from '../api/catalog'
import { invalidateFileAnnotations } from '../api/catalogFiles'
import { ConflictValue } from './CatalogConflictDialog'
import { useCatalogDraft } from './useCatalogDraft'

const MAX_RESOLVED_REFS = 40
const MAX_DISPLAY_MEMBERS = 12

const AFFECTED_QUERIES = [
  'catalog-browse',
  'catalog-detail',
  'catalog-bundle-summary',
  'catalog-selection',
  'catalog-view-counts',
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-navigation',
  'catalog-tag-counts',
  'catalog-inspector-files',
  'catalog-album',
  'catalog-file-star',
  'catalog-file-tags',
] as const

type ResolvedScope = {
  /** Primary entity key `family/id` for the browser item being reviewed. */
  subjectOwner: string
  /** Human-readable title for the focused header. */
  subjectTitle: string
  /** Actual held unit used as the anchor for `/history` and `choose`, or null if resolved. */
  activeUnit: string | null
  /** Every field in the server's structural scope. */
  fields: Field[]
  /** Loaded entities keyed by `family/id` for human-readable labels and values. */
  entities: Record<string, Entity>
}

function companionOwners(unit: string): [string, string][] {
  const [family = '', id = ''] = unit.split('/')
  const result: [string, string][] = []
  if (family && id) result.push([family, id])
  if (family === 'asset_file_stars' && id) {
    result.push(['asset_files', id])
  } else if (family === 'asset_file_tags' && id.includes('~')) {
    const [fileId, tagId] = id.split('~')
    if (tagId) result.push(['tags', tagId])
    if (fileId) result.push(['asset_files', fileId])
  } else if (family === 'asset_bundle_tags' && id.includes('~')) {
    const [bundleId, tagId] = id.split('~')
    if (tagId) result.push(['tags', tagId])
    if (bundleId) result.push(['asset_bundles', bundleId])
  } else if (family === 'asset_bundle_collections' && id.includes('~')) {
    const [bundleId, colId] = id.split('~')
    if (colId) result.push(['collections', colId])
    if (bundleId) result.push(['asset_bundles', bundleId])
  } else if (family === 'moment_tags' && id.includes('~')) {
    const [momentId, tagId] = id.split('~')
    if (tagId) result.push(['tags', tagId])
    if (momentId) result.push(['moments', momentId])
  } else if (family === 'tag_group_memberships' && id.includes('~')) {
    const [groupId, tagId] = id.split('~')
    if (tagId) result.push(['tags', tagId])
    if (groupId) result.push(['tag_groups', groupId])
  }
  return result
}

function friendlyEntityName(family: string, id: string, entities: Record<string, Entity>): string {
  const entity = entities[`${family}/${id}`]
  if (entity) {
    const label = entityLabel(entity)
    if (label && label !== entity.id) return label
    const rawPath = entity.fields.relative_path?.value
    if (rawPath && rawPath.startsWith('"')) {
      const path = JSON.parse(rawPath) as string
      return path.split('/').pop() || path
    }
  }
  switch (family) {
    case 'asset_bundles':
      return 'Untitled bundle'
    case 'asset_files':
      return 'File'
    case 'tags':
      return 'Tag'
    case 'collections':
      return 'Collection'
    case 'smart_folders':
      return 'Smart Collection'
    case 'bundle_directory_members':
      return 'Folder'
    default:
      return FAMILIES[family] ?? 'Item'
  }
}

function subjectHeading(unit: string, entities: Record<string, Entity>): string {
  const [family = '', id = ''] = unit.split('/')
  if (family === 'asset_file_stars' && id)
    return `Star on “${friendlyEntityName('asset_files', id, entities)}”`
  if (family === 'asset_file_tags' && id.includes('~')) {
    const [fileId = '', tagId = ''] = id.split('~')
    return `Tag “${friendlyEntityName('tags', tagId, entities)}” on “${friendlyEntityName('asset_files', fileId, entities)}”`
  }
  if (family === 'asset_bundle_tags' && id.includes('~')) {
    const [bundleId = '', tagId = ''] = id.split('~')
    return `Tag “${friendlyEntityName('tags', tagId, entities)}” on “${friendlyEntityName('asset_bundles', bundleId, entities)}”`
  }
  if (family === 'asset_bundle_collections' && id.includes('~')) {
    const [bundleId = '', colId = ''] = id.split('~')
    return `Collection “${friendlyEntityName('collections', colId, entities)}” on “${friendlyEntityName('asset_bundles', bundleId, entities)}”`
  }
  if (id === '_') return `${FAMILIES[family] ?? 'Catalog'} hierarchy`
  return friendlyEntityName(family, id, entities)
}

function readableFieldLegend(unit: string, entities: Record<string, Entity>): string {
  const [family = '', id = '', field = ''] = unit.split('/')
  if (family === 'asset_file_stars')
    return `Star on “${friendlyEntityName('asset_files', id, entities)}”`
  if (family === 'asset_file_tags' && id.includes('~')) {
    const [fileId = '', tagId = ''] = id.split('~')
    return `Tag “${friendlyEntityName('tags', tagId, entities)}” on “${friendlyEntityName('asset_files', fileId, entities)}”`
  }
  if (family === 'asset_bundle_tags' && id.includes('~')) {
    const [bundleId = '', tagId = ''] = id.split('~')
    return `Tag “${friendlyEntityName('tags', tagId, entities)}” on “${friendlyEntityName('asset_bundles', bundleId, entities)}”`
  }
  if (family === 'asset_bundle_collections' && id.includes('~')) {
    const [bundleId = '', colId = ''] = id.split('~')
    return `Collection “${friendlyEntityName('collections', colId, entities)}” on “${friendlyEntityName('asset_bundles', bundleId, entities)}”`
  }
  if (family === 'moment_tags' && id.includes('~')) {
    const [, tagId = ''] = id.split('~')
    return `Moment tag “${friendlyEntityName('tags', tagId, entities)}”`
  }
  if (id === '_' && field === '$forest') {
    return family === 'tags' ? 'Tag hierarchy and order' : 'Collection hierarchy and order'
  }
  const name = friendlyEntityName(family, id, entities)
  const singular =
    family === 'asset_bundles'
      ? 'Bundle'
      : family === 'asset_files'
        ? 'File'
        : family === 'tags'
          ? 'Tag'
          : family === 'collections'
            ? 'Collection'
            : family === 'smart_folders'
              ? 'Smart Collection'
              : (FAMILIES[family] ?? 'Item')
  switch (field) {
    case '$alive':
      return `${singular} “${name}”`
    case '$members':
      return `Files and order in “${name}”`
    case '$content':
      return `Content of “${name}”`
    case 'relative_path':
      return `Path of “${name}”`
    case '$filter':
      return `Conditions for “${name}”`
    case 'title':
    case 'display_title':
    case 'name':
      return `Title of “${name}”`
    case 'rating':
      return `Rating of “${name}”`
    case 'notes':
    case 'note':
      return `Notes on “${name}”`
    case 'source':
      return `Source of “${name}”`
    case 'cover_file_id':
      return `Cover of “${name}”`
    default:
      return `${singular} “${name}” · ${field.replace(/^\$/, '').replaceAll('_', ' ')}`
  }
}

function collectReferencedOwners(fields: Field[]): string[] {
  const refs = new Set<string>()
  for (const field of fields) {
    const [family = '', , name = ''] = field.unit.split('/')
    if (name !== '$members' && name !== '$forest') continue
    const options = [
      ...(field.value === null ? [] : [field.value]),
      ...field.candidates.map((c) => c.value),
    ]
    for (const raw of options) {
      try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) continue
        for (const item of parsed) {
          if (!item || typeof item !== 'object') continue
          const entry = item as { id?: string; family?: string; parent_id?: string | null }
          const refFamily = name === '$forest' ? family : (entry.family ?? 'asset_files')
          if (entry.id) refs.add(`${refFamily}/${entry.id}`)
          if (name === '$forest' && entry.parent_id) refs.add(`${family}/${entry.parent_id}`)
          if (refs.size >= MAX_RESOLVED_REFS) return [...refs]
        }
      } catch {
        /* Malformed or custom candidate JSON falls back to verbatim display. */
      }
    }
  }
  return [...refs]
}

async function resolveScope(library: string, requestedUnit: string): Promise<ResolvedScope> {
  const entities: Record<string, Entity> = {}
  const readEntity = async (family: string, id: string): Promise<Entity | null> => {
    const key = `${family}/${id}`
    if (entities[key]) return entities[key]!
    try {
      const loaded = await catalog<Entity>(library, `/entities/${key}`)
      entities[key] = loaded
      return loaded
    } catch (error) {
      // A membership can be held through its endpoint before the edge itself exists.
      if (error instanceof Error && error.message === 'Catalog identity is unavailable') return null
      throw error
    }
  }

  const candidates = companionOwners(requestedUnit)
  await Promise.all(candidates.map(([family, id]) => readEntity(family, id)))

  const [reqFamily = 'asset_bundles', reqId = '', reqField = ''] = requestedUnit.split('/')
  let activeUnit: string | null = null

  const primary = entities[`${reqFamily}/${reqId}`]
  if (primary && reqField && primary.fields[reqField]?.held) {
    activeUnit = primary.fields[reqField]!.unit
  } else if (primary && reqField === '$alive') {
    const firstHeld = Object.values(primary.fields)
      .filter((f) => f.held)
      .sort((a, b) => a.unit.localeCompare(b.unit))[0]
    if (firstHeld) activeUnit = firstHeld.unit
  }
  if (!activeUnit) {
    for (const [family, id] of candidates) {
      const entity = entities[`${family}/${id}`]
      if (!entity) continue
      const lifetime = entity.fields.$alive
      if (lifetime?.held) {
        activeUnit = lifetime.unit
        break
      }
    }
  }

  const fallbackOwner =
    candidates.map(([f, i]) => `${f}/${i}`).find((key) => Boolean(entities[key])) ??
    `${reqFamily}/${reqId}`

  if (!activeUnit) {
    return {
      subjectOwner: fallbackOwner,
      subjectTitle: subjectHeading(requestedUnit, entities),
      activeUnit: null,
      fields: [],
      entities,
    }
  }

  const history = await catalog<{ scope: string[] }>(
    library,
    `/history?unit=${encodeURIComponent(activeUnit)}`,
  )
  const scopeOwners = [
    ...new Set(history.scope.map((item) => item.split('/').slice(0, 2).join('/'))),
  ]
  await Promise.all(
    scopeOwners.map((owner) => {
      const [f = '', i = ''] = owner.split('/')
      return readEntity(f, i)
    }),
  )
  // Load endpoint entities of any ~ edge in scope so legends show names rather than raw IDs
  const endpointReads: Promise<Entity | null>[] = []
  for (const owner of scopeOwners) {
    const [f = '', i = ''] = owner.split('/')
    for (const [cf, ci] of companionOwners(`${f}/${i}/$alive`)) {
      if (!entities[`${cf}/${ci}`]) endpointReads.push(readEntity(cf, ci))
    }
  }
  if (endpointReads.length) await Promise.all(endpointReads)

  const fields = history.scope.map((item) => {
    const [f = '', i = '', fld = ''] = item.split('/')
    const field = entities[`${f}/${i}`]?.fields[fld]
    if (!field) throw new Error('The conflict changed while loading. Refresh its details.')
    return field
  })

  const refs = collectReferencedOwners(fields).filter((key) => !entities[key])
  if (refs.length) {
    await Promise.all(
      refs.map((key) => {
        const [f = '', i = ''] = key.split('/')
        return readEntity(f, i)
      }),
    )
  }

  const activeOwner = activeUnit.split('/').slice(0, 2).join('/')
  return {
    subjectOwner: entities[fallbackOwner] ? fallbackOwner : activeOwner,
    subjectTitle: subjectHeading(requestedUnit, entities),
    activeUnit,
    fields,
    entities,
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

function CandidateDisplay({
  unit,
  raw,
  entities,
  label,
}: {
  unit: string
  raw: string
  entities: Record<string, Entity>
  label: string
}) {
  const [family = '', id = '', field = ''] = unit.split('/')
  if (field === '$alive') {
    if (family === 'asset_file_stars') {
      return <span>{raw === 'true' ? 'Starred' : raw === 'false' ? 'Not starred' : raw}</span>
    }
    if (id.includes('~')) {
      return <span>{raw === 'true' ? 'Assigned' : raw === 'false' ? 'Removed' : raw}</span>
    }
    return (
      <span>
        {raw === 'true' ? 'Keep in library' : raw === 'false' ? 'Keep deleted' : displayCell(raw)}
      </span>
    )
  }
  if (field === '$members' || field === '$forest') {
    const parsed = parseJson(raw)
    if (Array.isArray(parsed)) {
      const entries = parsed as {
        id: string
        family?: string
        parent_id?: string | null
      }[]
      if (entries.length === 0) {
        return (
          <span className="conflict-review__empty">
            {field === '$forest' ? 'No items in hierarchy' : 'No files in bundle'}
          </span>
        )
      }
      const shown = entries.slice(0, MAX_DISPLAY_MEMBERS)
      const remaining = entries.length - shown.length
      return (
        <div className="focused-conflict__arrangement">
          <ol className="conflict-review__notes">
            {shown.map((entry, idx) => {
              const refFamily = field === '$forest' ? family : (entry.family ?? 'asset_files')
              const itemName = friendlyEntityName(refFamily, entry.id, entities)
              const parentName =
                field === '$forest' && entry.parent_id
                  ? friendlyEntityName(family, entry.parent_id, entities)
                  : null
              return (
                <li key={`${entry.id}-${idx}`}>
                  {parentName ? `${parentName} / ${itemName}` : itemName}
                </li>
              )
            })}
          </ol>
          {remaining > 0 && <span className="conflict-review__empty">and {remaining} more</span>}
        </div>
      )
    }
  }
  if (field === '$filter') {
    const outer = parseJson(raw) as { filter_json?: string } | undefined
    if (outer && typeof outer === 'object' && typeof outer.filter_json === 'string') {
      return <span className="catalog-exact">{outer.filter_json}</span>
    }
  }
  if (
    [
      'title',
      'display_title',
      'rating',
      'notes',
      'note',
      'source',
      'cover_file_id',
      'primary_file_id',
      'cover_time',
    ].includes(field)
  ) {
    return <ConflictValue bundle={id} unit={unit} raw={raw} name={label} />
  }
  return <span className="catalog-exact">{displayCell(raw)}</span>
}

function ScopeBody({
  library,
  editor,
  scope,
  blocked,
  returnLabel,
  onBack,
  onCommitted,
}: {
  library: string
  editor: string
  scope: ResolvedScope & { activeUnit: string }
  blocked: boolean
  returnLabel: string
  onBack: () => void
  onCommitted: () => void
}) {
  const client = useQueryClient()
  const { activeUnit, fields, entities } = scope
  const draft = useCatalogDraft(library, `review/${activeUnit}`, editor, {
    choices: {} as Record<string, string>,
    recover: false,
    observed: {} as Record<string, string>,
  })
  const previewDraft = useCatalogDraft(library, `preview/review/${activeUnit}`, editor, { job: '' })
  const submittedPreview = useRef('')
  const [prepared, setPrepared] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const job = previewDraft.body.job
    if (!job || job === submittedPreview.current) return
    const submission = submittedPreview.current
    let current = true
    void catalog<Job>(library, `/jobs/${job}`)
      .then((result) => {
        if (current && submittedPreview.current === submission) setPrepared(result)
      })
      .catch((reason: Error) => {
        if (current && submittedPreview.current === submission) setError(reason.message)
      })
    return () => {
      current = false
    }
  }, [library, previewDraft.body.job])

  const { choices, recover } = draft.body
  const bases = () =>
    Object.keys(draft.body.observed).length
      ? draft.body.observed
      : Object.fromEntries(fields.map((field) => [field.unit, JSON.stringify(field.basis)]))

  function closePreview() {
    setPrepared(null)
    if (previewDraft.body.job) {
      submittedPreview.current = previewDraft.body.job
      previewDraft.update({ job: '' })
    }
  }

  const setChoices = (next: Record<string, string>) => {
    closePreview()
    draft.update({ choices: next, recover, observed: bases() })
  }
  const setRecover = (next: boolean) => {
    closePreview()
    draft.update({ choices, recover: next, observed: bases() })
  }

  const selected = (field: Field) =>
    choices[field.unit] ?? (field.candidates.length === 1 ? (field.value ?? undefined) : undefined)

  // Highlight when a chosen live value supersedes an observed deletion and therefore needs `recover`
  const needsExplicitRecovery = fields.some(
    (field) =>
      field.unit.endsWith('/$alive') &&
      selected(field) === 'true' &&
      (field.value === 'false' || field.candidates.some((c) => c.value === 'false')),
  )

  async function prepare() {
    setBusy(true)
    setError('')
    setPrepared(null)
    try {
      const operation = operationId()
      submittedPreview.current = operation
      previewDraft.update({ job: operation })
      const result = await runJob(
        library,
        'preview',
        {
          action: 'choose',
          unit: activeUnit,
          recover,
          choices: Object.fromEntries(fields.map((field) => [field.unit, selected(field)])),
          observed: Object.fromEntries(
            Object.entries(bases()).map(([target, raw]) => [target, JSON.parse(raw) as string[]]),
          ),
        },
        operation,
      )
      setPrepared(result)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function applyPrepared() {
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
      await draft.discard()
      setPrepared(null)
      await Promise.all([
        ...AFFECTED_QUERIES.map((key) => client.invalidateQueries({ queryKey: [key, library] })),
        invalidateFileAnnotations(client, library),
      ])
      window.dispatchEvent(new Event('cairndex:metadata-saved'))
      onCommitted()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="focused-conflict__card" aria-label="Complete conflict review">
      <h3>Review affected metadata</h3>
      <p className="focused-conflict__lead">
        Choose the version to keep for each affected item or relationship below. Other versions stay
        in history, and source media on disk is untouched.
      </p>
      {draft.error && <p role="alert">{draft.error}</p>}
      {previewDraft.error && <p role="alert">{previewDraft.error}</p>}
      {error && <p role="alert">{error}</p>}
      {draft.copies.map((copy) => (
        <button key={copy.id} className="btn btn--sm" onClick={() => draft.update(copy.body)}>
          Recover conflict review draft {copy.revision}
        </button>
      ))}
      {previewDraft.copies.map((copy) => (
        <button
          key={copy.id}
          className="btn btn--sm"
          onClick={() => previewDraft.update(copy.body)}
        >
          Recover prepared operation {copy.revision}
        </button>
      ))}

      <div className="focused-conflict__fields">
        {fields.map((field) => {
          const legend = readableFieldLegend(field.unit, entities)
          const options = [
            ...new Set([
              ...(field.value === null ? [] : [field.value]),
              ...field.candidates.map((candidate) => candidate.value),
            ]),
          ]
          return (
            <fieldset key={field.unit} className="conflict-review__field" disabled={busy}>
              <legend>{legend}</legend>
              {options.map((raw, index) => (
                <label
                  key={raw}
                  className={`conflict-review__option${selected(field) === raw ? ' is-selected' : ''}`}
                >
                  <input
                    type="radio"
                    name={field.unit}
                    checked={selected(field) === raw}
                    onChange={() => setChoices({ ...choices, [field.unit]: raw })}
                  />
                  <span className="conflict-review__value">
                    <CandidateDisplay
                      unit={field.unit}
                      raw={raw}
                      entities={entities}
                      label={`${legend} option ${index + 1}`}
                    />
                  </span>
                  {raw === field.value && <span className="conflict-review__tag">Shown now</span>}
                </label>
              ))}
              <details className="focused-conflict__compose">
                <summary>Compose a replacement</summary>
                <label>
                  Complete value as JSON
                  <textarea
                    aria-label={`Replacement for ${field.unit}`}
                    value={choices[field.unit] ?? ''}
                    onChange={(event) =>
                      setChoices({ ...choices, [field.unit]: event.target.value })
                    }
                  />
                </label>
              </details>
            </fieldset>
          )
        })}
      </div>

      <label
        className={`focused-conflict__recover${needsExplicitRecovery && !recover ? ' is-needed' : ''}`}
      >
        <input
          type="checkbox"
          checked={recover}
          disabled={busy}
          onChange={(event) => setRecover(event.target.checked)}
        />
        <span>
          Explicitly restore a deleted identity and its reviewed relationships
          {needsExplicitRecovery && !recover && (
            <span className="focused-conflict__recover-hint">
              {' '}
              (required when keeping an item that was deleted on another device)
            </span>
          )}
        </span>
      </label>

      <div className="focused-conflict__actions">
        <button
          className="btn btn--primary"
          disabled={busy || blocked || fields.some((field) => selected(field) === undefined)}
          onClick={() => void prepare()}
        >
          {busy && !prepared ? 'Preparing…' : 'Prepare choice'}
        </button>
        <button
          className="btn"
          disabled={busy}
          onClick={() => {
            closePreview()
            setError('')
            void draft.discard()
          }}
        >
          Start a fresh review
        </button>
        <button className="btn" disabled={busy} onClick={onBack}>
          Back to {returnLabel}
        </button>
      </div>

      {prepared?.result && (
        <section className="focused-conflict__prepared" aria-label="Prepared catalog operation">
          <h3>Review complete operation</h3>
          <p>All shown changes are applied together. Physical files remain in place.</p>
          <ul className="focused-conflict__changes">
            {prepared.result.changes.map((change) => (
              <li key={change.unit}>
                <strong>{readableFieldLegend(change.unit, entities)}</strong>:{' '}
                <CandidateDisplay
                  unit={change.unit}
                  raw={change.value}
                  entities={entities}
                  label={readableFieldLegend(change.unit, entities)}
                />
              </li>
            ))}
          </ul>
          <details className="focused-conflict__compose">
            <summary>Exact catalog units</summary>
            {prepared.result.changes.map((change) => (
              <div key={change.unit}>
                <strong>{change.unit}</strong>
                <p className="catalog-exact">{displayCell(change.value)}</p>
              </div>
            ))}
          </details>
          <div className="focused-conflict__actions">
            <button
              className="btn btn--primary"
              disabled={busy || blocked}
              onClick={() => void applyPrepared()}
            >
              {busy ? 'Applying…' : 'Apply reviewed operation'}
            </button>
            <button className="btn" disabled={busy} onClick={closePreview}>
              Close preview
            </button>
          </div>
        </section>
      )}
    </section>
  )
}

export function CatalogFocusedConflictReview({
  library,
  editor,
  unit,
  blocked,
  returnLabel,
  onBack,
  onOpenMetadataReview,
  onResolved,
}: {
  library: string
  editor: string
  unit: string
  blocked: boolean
  returnLabel: string
  onBack: () => void
  onOpenMetadataReview: (family: string, id: string, activeUnit: string | null) => void
  onResolved: () => void
}) {
  const [committedOnce, setCommittedOnce] = useState(false)
  const scopeQuery = useQuery({
    queryKey: ['catalog-focused-conflict', library, unit],
    queryFn: () => resolveScope(library, unit),
  })

  const scope = scopeQuery.data
  const [ownerFamily = 'asset_bundles', ownerId = ''] = (
    scope?.subjectOwner ?? unit.split('/').slice(0, 2).join('/')
  ).split('/')

  return (
    <div className="focused-conflict" aria-label="Conflict review">
      <header className="focused-conflict__header">
        <button type="button" className="btn" onClick={onBack}>
          ‹ Back to {returnLabel}
        </button>
        <div className="focused-conflict__titles">
          <h1>{scope ? `Conflict Review · ${scope.subjectTitle}` : 'Conflict Review'}</h1>
        </div>
        <button
          type="button"
          className="btn btn--sm"
          onClick={() => onOpenMetadataReview(ownerFamily, ownerId, scope?.activeUnit ?? null)}
        >
          Open in Metadata Review
        </button>
      </header>

      {scopeQuery.isPending && <p role="status">Loading conflict details…</p>}
      {scopeQuery.error && (
        <div role="alert" className="focused-conflict__card">
          <p>Conflict details could not be loaded. {scopeQuery.error.message}</p>
          <div className="focused-conflict__actions">
            <button className="btn" onClick={() => void scopeQuery.refetch()}>
              Try Again
            </button>
            <button className="btn" onClick={onBack}>
              Back to {returnLabel}
            </button>
          </div>
        </div>
      )}

      {scope && scope.activeUnit === null && (
        <section className="focused-conflict__card" role="status">
          <h2>{committedOnce ? 'Conflict resolved' : 'No conflicts remain'}</h2>
          <p>
            {committedOnce
              ? 'Your choice has been saved and no further conflicts remain on this item.'
              : 'Every edit for this item is already combined.'}
          </p>
          <div className="focused-conflict__actions">
            <button className="btn btn--primary" onClick={onBack}>
              Return to {returnLabel}
            </button>
          </div>
        </section>
      )}

      {scope && scope.activeUnit !== null && (
        <ScopeBody
          key={scope.activeUnit}
          library={library}
          editor={editor}
          scope={scope as ResolvedScope & { activeUnit: string }}
          blocked={blocked}
          returnLabel={returnLabel}
          onBack={onBack}
          onCommitted={() => {
            setCommittedOnce(true)
            onResolved()
            void scopeQuery.refetch().then((next) => {
              if (next.data && next.data.activeUnit === null) onBack()
            })
          }}
        />
      )}
    </div>
  )
}
