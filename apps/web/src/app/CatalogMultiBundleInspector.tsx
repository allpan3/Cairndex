import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, CatalogJobError, operationId } from '../api/catalog'
import { commit } from '../api/catalogOrganize'
import type { components } from '../api/schema'
import { CatalogBundleMemberships } from './CatalogBundleMemberships'
import { StarRating } from './Stars'
import { useCatalogDraft } from './useCatalogDraft'
import { validCatalogBulkDraft } from './catalogBulkDraft'

type Snapshot = components['schemas']['CatalogSelectionRead']
const empty = {
  snapshot: '',
  field: 'title',
  value: '',
  command: '',
  operation: '',
  applying: '',
  label: '',
}
// Every view that shows a selected bundle's title or rating
const AFFECTED = ['catalog-browse', 'catalog-detail', 'catalog-selection', 'catalog-view-counts']

/**
 * v0.2.1's inspector for several bundles: one title for all of them, one
 * rating, and their tags and collections as chips. Each change saves when it is
 * made. Its command is retained first, so a save whose reply was lost reopens
 * after a reload and retries the same operation instead of applying twice.
 */
export function CatalogMultiBundleInspector({
  library,
  editor,
  ids,
  fileCount,
  blocked,
  memberships,
  onReview,
  onRetain,
  onClose,
}: {
  library: string
  editor: string
  ids: string[]
  /** The selected cards' files together. */
  fileCount: number
  blocked: boolean
  /** The server can list a selection's own tags and collections (`selection_version: 3`). */
  memberships: boolean
  onReview: () => void
  /** A save is retained, so the inspector stays open once the selection changes. */
  onRetain: () => void
  onClose: () => void
}) {
  const client = useQueryClient()
  const draft = useCatalogDraft(library, 'bulk', editor, empty, validCatalogBulkDraft)
  const [title, setTitle] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const cancelled = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const supported = ids.length > 0 && ids.length <= 100
  const snapshot = useQuery({
    queryKey: ['catalog-selection', library, ids],
    enabled: supported,
    queryFn: () => catalog<Snapshot>(library, '/bundles/selection', 'POST', { ids }),
    refetchInterval: 2000,
  })
  const items = snapshot.data?.items ?? []
  const held = items.some((item) => item.held)
  const retained = Boolean(draft.body.operation)
  const locked = busy || blocked || retained || !snapshot.data || held
  useEffect(() => {
    if (draft.body.operation) onRetain()
  }, [draft.body.operation, onRetain])
  const titles = new Set(items.map((item) => item.title ?? ''))
  const common = titles.size === 1 ? [...titles][0]! : ''
  const ratings = new Set(items.map((item) => item.rating ?? 0))
  const rating = ratings.size === 1 ? [...ratings][0]! : 0

  async function run(intent: typeof empty) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await commit(library, JSON.parse(intent.command), intent.operation)
      draft.update(empty)
      setMessage('Saved here')
      for (const key of AFFECTED) await client.invalidateQueries({ queryKey: [key, library] })
    } catch (reason) {
      // The server refused it, so there is nothing left to retry
      if (reason instanceof CatalogJobError) draft.update(empty)
      setError((reason as Error).message)
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  function save(field: 'title' | 'rating', value: string | number | null, label: string) {
    if (locked) return
    const observed = Object.fromEntries(
      items.flatMap((item) =>
        Object.entries(item.observed).filter(
          ([unit]) => unit.endsWith(`/${field}`) || unit.endsWith('/$alive'),
        ),
      ),
    )
    const command = { action: 'bulk', ids: items.map((item) => item.id), field, value, observed }
    const intent = {
      snapshot: JSON.stringify(snapshot.data),
      field,
      value: value == null ? '' : String(value),
      command: JSON.stringify(command),
      operation: operationId(),
      applying: 'true',
      label,
    }
    draft.update(intent)
    void run(intent)
  }
  function commitTitle() {
    const next = title?.trim() ?? ''
    setTitle(null)
    if (cancelled.current) {
      cancelled.current = false
      return
    }
    if (next && !(titles.size === 1 && common === next)) save('title', next, `Set title: ${next}`)
  }
  const pending = draft.body.operation
    ? (JSON.parse(draft.body.snapshot) as Snapshot).items.length
    : 0
  return (
    <aside className="inspector catalog-bulk-inspector" aria-label="Selected bundles inspector">
      <div className="inspector__multi-head">
        <h2>{ids.length} bundles selected</h2>
        <button className="add-btn" onClick={onClose}>
          Clear
        </button>
      </div>
      {retained && (
        <p className="catalog-bulk-inspector__retry" role="alert">
          {draft.body.label} for {pending} bundles did not finish saving.{' '}
          <button className="btn btn--sm" disabled={busy} onClick={() => void run(draft.body)}>
            Retry bulk save
          </button>
        </p>
      )}
      {ids.length > 100 && <p>Select up to 100 bundles to change them together.</p>}
      {snapshot.error && (
        <p role="alert">
          The selected bundles are unavailable.{' '}
          <button className="btn btn--sm" onClick={() => void snapshot.refetch()}>
            Try Again
          </button>
        </p>
      )}
      {held && (
        <p role="alert">
          <span>Competing metadata requires review.</span>{' '}
          <button className="btn btn--sm" onClick={onReview}>
            Review Conflicts
          </button>
        </p>
      )}
      {supported && (
        <>
          <input
            className="edit edit--title"
            value={title ?? common}
            placeholder="Multiple titles — type to rename all"
            disabled={locked}
            onFocus={() => setTitle(common)}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={commitTitle}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
              if (event.key === 'Escape') {
                cancelled.current = true
                event.currentTarget.blur()
              }
            }}
            aria-label="Title"
          />
          <div className="prop">
            <span className="prop__k">Rating</span>
            <StarRating
              value={rating}
              onChange={(value) =>
                save('rating', value || null, `Set rating: ${value || 'Not set'}`)
              }
            />
          </div>
          <div className="prop">
            <span className="prop__k">Files</span>
            <span className="prop__v">{fileCount}</span>
          </div>
          {memberships &&
            (['tags', 'collections'] as const).map((family) => (
              <CatalogBundleMemberships
                key={family}
                library={library}
                ids={ids}
                family={family}
                blocked={blocked || retained}
                onReview={onReview}
              />
            ))}
        </>
      )}
      {(error || draft.error) && <p role="alert">{error || draft.error}</p>}
      {message && <p role="status">{message}</p>}
    </aside>
  )
}
