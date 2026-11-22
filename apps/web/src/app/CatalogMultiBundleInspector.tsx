import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, CatalogJobError, operationId } from '../api/catalog'
import {
  CatalogBulkIncomplete,
  changeableTogether,
  readSelection,
  runBulk,
  SELECTION_REQUEST,
  selectionKey,
} from '../api/catalogBulk'
import { commit } from '../api/catalogOrganize'
import { bundleLockKey, withCatalogWriteLock } from '../api/catalogWriteQueue'
import { useReplicaStatus } from '../api/useReplicaStatus'
import type { components } from '../api/schema'
import { formatBytes } from '../lib/format'
import { CatalogBundleMemberships } from './CatalogBundleMemberships'
import { StarRating } from './Stars'
import { useCatalogDraft } from './useCatalogDraft'
import { validCatalogBulkDraft } from './catalogBulkDraft'
import { BundleCoverStack } from './BundleCoverStack'
import type { BundleCardItem } from './BundleCard'
import { CatalogConflictDialog } from './CatalogConflictDialog'
import { SELECT_BUNDLES_EVENT } from './catalogBulkNotice'

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
// Every view that shows a selected bundle's title, rating, or chips
const AFFECTED = [
  'catalog-browse',
  'catalog-detail',
  'catalog-selection',
  'catalog-view-counts',
  'catalog-memberships',
  'catalog-bulk-memberships',
]

function sameRevisionSet(a?: string[], b?: string[]): boolean {
  if (!a || !b || a.length !== b.length) return false
  const right = new Set(b)
  return a.every((rev) => right.has(rev))
}

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
  conflictedIds = [],
  covers = [],
  fileCount,
  totalSize,
  blocked,
  memberships,
  onReview,
  onReviewConflict,
  onRetainedChange,
  onClose,
  onFilterTag,
}: {
  library: string
  editor: string
  ids: string[]
  conflictedIds?: string[]
  covers?: BundleCardItem[]
  /** The selected cards' files together. */
  fileCount: number | null
  totalSize?: number | null
  blocked: boolean
  /** The server can list a selection's own tags and collections (`selection_version: 3`). */
  memberships: boolean
  onReview: () => void
  /** Open Metadata Review on one structural conflict; falls back to `onReview`. */
  onReviewConflict?: (unit: string) => void
  /** Retain only unfinished work after its original selection changes. */
  onRetainedChange: (retained: boolean) => void
  onClose: () => void
  onFilterTag?: (id: string) => void
}) {
  const client = useQueryClient()
  const draft = useCatalogDraft(library, 'bulk', editor, empty, validCatalogBulkDraft)
  const [title, setTitle] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const cancelled = useRef(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [reviewing, setReviewing] = useState(false)
  // Bundles a bulk change left as they were, which the owner can select again
  const [unchanged, setUnchanged] = useState<string[]>([])
  const selectionVersion = useReplicaStatus(library).data?.selection_version ?? 0
  const supported = ids.length > 0 && changeableTogether(ids.length, selectionVersion)
  // A larger selection reads chunk by chunk, so it is read again only after a change
  const large = ids.length > SELECTION_REQUEST
  const named = useMemo(() => selectionKey(ids), [ids])
  const snapshot = useQuery({
    queryKey: ['catalog-selection', library, named],
    enabled: supported,
    queryFn: () =>
      large
        ? readSelection(library, ids)
        : catalog<Snapshot>(library, '/bundles/selection', 'POST', { ids }),
    refetchInterval: large ? false : 2000,
  })
  const items = snapshot.data?.items ?? []
  const held = items.some((item) => item.held)
  const reviewIds = [
    ...new Set([...items.filter((item) => item.held).map((item) => item.id), ...conflictedIds]),
  ]
  const retained = Boolean(draft.body.operation)
  const locked = busy || blocked || retained || !snapshot.data || held
  useEffect(() => {
    onRetainedChange(retained || busy)
  }, [retained, busy, onRetainedChange])
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
      const command = JSON.parse(intent.command) as {
        ids?: string[]
        field?: string
        observed?: Record<string, string[]>
      } & Record<string, unknown>
      const lockKeys = (command.ids ?? ids).map((id) => bundleLockKey(library, id))
      await withCatalogWriteLock(lockKeys, async ({ waited }) => {
        let activeCommand: Record<string, unknown> = command
        if (
          waited &&
          !large &&
          Array.isArray(command.ids) &&
          command.ids.length > 0 &&
          command.field &&
          command.observed
        ) {
          const fresh = await catalog<Snapshot>(library, '/bundles/selection', 'POST', {
            ids: command.ids,
          })
          if (!fresh.items.some((item) => item.held) && fresh.items.length === command.ids.length) {
            const byId = new Map(fresh.items.map((item) => [item.id, item]))
            const fieldUnchanged = command.ids.every((id) => {
              const item = byId.get(id)
              if (!item) return false
              const fieldUnit = `asset_bundles/${id}/${command.field}`
              return sameRevisionSet(command.observed?.[fieldUnit], item.observed[fieldUnit])
            })
            if (fieldUnchanged) {
              const nextObserved = { ...command.observed }
              for (const id of command.ids) {
                const aliveUnit = `asset_bundles/${id}/$alive`
                const freshAlive = byId.get(id)?.observed[aliveUnit]
                if (freshAlive) nextObserved[aliveUnit] = freshAlive
              }
              activeCommand = { ...command, observed: nextObserved }
            }
          }
        }
        await commit(library, activeCommand, intent.operation)
        draft.update(empty)
        setMessage('Saved here')
        for (const key of AFFECTED) await client.invalidateQueries({ queryKey: [key, library] })
      })
    } catch (reason) {
      // The server refused it, so there is nothing left to retry
      if (reason instanceof CatalogJobError) draft.update(empty)
      setError((reason as Error).message)
      void client.invalidateQueries({ queryKey: ['catalog-selection', library] })
      void client.invalidateQueries({ queryKey: ['catalog-browse', library] })
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  // The bases each bundle was shown with, which its change must still match
  const reviewed = (observed: Record<string, string[]>, field: string) =>
    Object.entries(observed).filter(
      ([unit]) => unit.endsWith(`/${field}`) || unit.endsWith('/$alive'),
    )
  // Above one request the server applies the change in batches; a bundle changed since
  // it was read is left as it was and listed
  async function runLarge(field: 'title' | 'rating', value: string | number | null) {
    if (running.current) return
    running.current = true
    setBusy(true)
    setError('')
    setMessage('')
    setUnchanged([])
    try {
      await withCatalogWriteLock(
        items.map((item) => bundleLockKey(library, item.id)),
        async ({ waited }) => {
          let targets = items.map((item) => ({
            id: item.id,
            observed: Object.fromEntries(reviewed(item.observed, field)),
          }))
          if (waited && items.length > 0) {
            const fresh = await readSelection(
              library,
              items.map((item) => item.id),
            )
            const byId = new Map(fresh.items.map((item) => [item.id, item]))
            targets = targets.map((entry) => {
              const latest = byId.get(entry.id)
              const fieldUnit = `asset_bundles/${entry.id}/${field}`
              const aliveUnit = `asset_bundles/${entry.id}/$alive`
              if (
                latest &&
                !latest.held &&
                sameRevisionSet(entry.observed[fieldUnit], latest.observed[fieldUnit]) &&
                latest.observed[aliveUnit]
              ) {
                return {
                  id: entry.id,
                  observed: { ...entry.observed, [aliveUnit]: latest.observed[aliveUnit] },
                }
              }
              return entry
            })
          }
          await runBulk(library, targets, { action: 'bulk', field, value })
          setMessage('Saved here')
        },
      )
    } catch (reason) {
      if (reason instanceof CatalogBulkIncomplete) setUnchanged(reason.unchanged)
      setError((reason as Error).message)
    } finally {
      for (const key of AFFECTED) await client.invalidateQueries({ queryKey: [key, library] })
      running.current = false
      setBusy(false)
    }
  }
  const patchOptimisticSelection = (field: 'title' | 'rating', value: string | number | null) => {
    const idSet = new Set(ids)
    client.setQueryData<Snapshot>(['catalog-selection', library, named], (current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) => ({
              ...item,
              ...(field === 'title'
                ? { title: value as string | null }
                : { rating: value as number | null }),
            })),
          }
        : current,
    )
    client.setQueriesData<{ pages: { items: Record<string, unknown>[] }[] }>(
      { queryKey: ['catalog-browse', library] },
      (data) =>
        data?.pages
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) =>
                  idSet.has(String(item.id)) ? { ...item, [field]: value } : item,
                ),
              })),
            }
          : data,
    )
  }
  function save(field: 'title' | 'rating', value: string | number | null, label: string) {
    if (locked) return
    if (large) {
      patchOptimisticSelection(field, value)
      void runLarge(field, value)
      return
    }
    const observed = Object.fromEntries(items.flatMap((item) => reviewed(item.observed, field)))
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
    patchOptimisticSelection(field, value)
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
        <h2>{ids.length.toLocaleString()} bundles selected</h2>
        <button className="add-btn" onClick={onClose}>
          Clear
        </button>
      </div>
      {covers.length > 0 && <BundleCoverStack items={covers} />}
      {retained && (
        <p className="catalog-bulk-inspector__retry" role="alert">
          {draft.body.label} for {pending} bundles did not finish saving.{' '}
          <button className="btn btn--sm" disabled={busy} onClick={() => void run(draft.body)}>
            Retry bulk save
          </button>
        </p>
      )}
      {!supported && ids.length > SELECTION_REQUEST && (
        <p>Select up to 100 bundles to change them together.</p>
      )}
      {snapshot.error && (
        <p role="alert">
          The selected bundles are unavailable.{' '}
          <button className="btn btn--sm" onClick={() => void snapshot.refetch()}>
            Try Again
          </button>
        </p>
      )}
      {reviewIds.length > 0 && (
        <p role="alert">
          <span>Some selected bundles have conflicting edits.</span>{' '}
          <button className="btn btn--sm" onClick={() => setReviewing(true)}>
            Review Conflicts
          </button>
        </p>
      )}
      {reviewing && (
        <CatalogConflictDialog
          library={library}
          bundles={reviewIds}
          blocked={blocked}
          onClose={() => setReviewing(false)}
          onResolved={() => {
            for (const key of AFFECTED) void client.invalidateQueries({ queryKey: [key, library] })
            window.dispatchEvent(new Event('cairndex:metadata-saved'))
          }}
          onAdvanced={(unit) => {
            setReviewing(false)
            if (onReviewConflict) onReviewConflict(unit)
            else onReview()
          }}
        />
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
            <span className="prop__v">{fileCount ?? 'Unknown'}</span>
          </div>
          <div className="prop">
            <span className="prop__k">Size</span>
            <span className="prop__v">
              {totalSize == null ? 'Unknown on this device' : formatBytes(totalSize)}
            </span>
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
                onReviewConflict={onReviewConflict}
                onFilterTag={onFilterTag}
              />
            ))}
        </>
      )}
      {(error || draft.error) && (
        <p role="alert">
          {error || draft.error}
          {unchanged.length > 0 && (
            <>
              {' '}
              <button
                className="btn btn--sm"
                onClick={() =>
                  window.dispatchEvent(new CustomEvent(SELECT_BUNDLES_EVENT, { detail: unchanged }))
                }
              >
                Select Unchanged
              </button>
            </>
          )}
        </p>
      )}
      {message && <p role="status">{message}</p>}
    </aside>
  )
}
