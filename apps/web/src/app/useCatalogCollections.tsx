// The collection tree and its one-gesture changes, shared by the sidebar and the
// browser's folder cards so both act through the same requests and dialogs.
import { type ReactNode, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalogNavigation } from '../api/catalogQuery'
import type { CollectionRead } from '../api/client'
import {
  arrangeHierarchy,
  moveBundlesToCollection,
  moveCollections,
  remove,
  setCollectionMembership,
  sortCollectionsByName,
} from '../api/catalogOrganize'
import { CatalogBulkIncomplete } from '../api/catalogBulk'
import { plannedChange, type MembershipChange } from '../api/catalogUndo'
import { captureRequestScope } from '../api/requestScope'
import { failureNotice } from './catalogBulkNotice'
import type { CatalogNotice } from './CatalogToast'
import { CleanupOrderDialog } from './CleanupOrderDialog'
import { getActiveDrag, type DragItem } from './dnd'
import { bundleCount, membershipText, type OrganizeUndo } from './organizeUndo'
import { RemoveCollectionDialog } from './RemoveCollectionDialog'
import type { Selection } from './types'

/** A navigation collection: `count` is its subtree, `direct_count` its own bundles. */
export type CatalogCollection = CollectionRead & { count: number; direct_count?: number }

export interface CatalogCollections {
  items: CatalogCollection[]
  error: Error | null
  retry: () => void
  /** Refresh every view that shows collections or their counts. */
  refresh: () => Promise<void>
  /** Save at once and refresh every view that shows collections; a failure is reported. */
  run: (action: () => Promise<void>, done?: () => void, failed?: () => void) => void
  /** Move collections into `parent`, in front of `before` (null: at the end). */
  arrange: (moved: string[], parent: string | null, before: string | null) => void
  /** Drop the dragged bundles on `target`; `copy` adds without leaving this collection. */
  moveBundlesInto: (target: string, copy: boolean) => void
  /** Take bundles out of the open collection; like a move, they leave its grid at once. */
  removeBundlesFromOpen: (ids: string[]) => void
  /** Bundles moving out of the open collection, hidden from its grid until the move settles */
  leaving: ReadonlySet<string>
  requestDelete: (collections: CollectionRead[]) => void
  requestCleanup: () => void
  /** The confirmation dialogs these actions open. */
  dialogs: ReactNode
}

export function useCatalogCollections(
  library: string,
  {
    selection,
    onSelect,
    onNotice,
    dragItem,
    undo,
  }: {
    selection: Selection
    onSelect: (selection: Selection) => void
    onNotice: (notice: CatalogNotice) => void
    dragItem: DragItem | null
    /** Reports bundle moves and removals, with their Undo */
    undo: OrganizeUndo
  },
): CatalogCollections {
  const collections = useQuery({
    queryKey: ['catalog-navigation', library, 'collections'],
    queryFn: () => catalogNavigation<CatalogCollection>(library, 'collections'),
    refetchInterval: 2000,
  })
  const client = useQueryClient()
  const [deleting, setDeleting] = useState<CollectionRead[] | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set())
  const items = collections.data ?? []
  const names = Object.fromEntries(items.map((item) => [item.id, item.name]))
  const refresh = async () => {
    await Promise.all(
      [
        'catalog-navigation',
        'catalog-browse',
        'catalog-detail',
        'catalog-memberships',
        'catalog-view-counts',
      ].map((key) => client.invalidateQueries({ queryKey: [key, library] })),
    )
  }
  // Each change saves at once; a reply after a library switch is dropped
  function run(action: () => Promise<void>, done?: () => void, failed?: () => void) {
    const current = captureRequestScope()
    void action()
      .then(async () => {
        current()
        await refresh()
        done?.()
      })
      .catch((reason: Error) => {
        try {
          current()
        } catch {
          return
        }
        // A bulk change that stopped part way saved its finished batches
        if (reason instanceof CatalogBulkIncomplete) void refresh()
        onNotice(failureNotice(reason))
        failed?.()
      })
  }
  const arrange = (moved: string[], parent: string | null, before: string | null) =>
    run(() =>
      arrangeHierarchy(library, 'collections', (forest) =>
        moveCollections(forest, names, moved, parent, before),
      ),
    )
  // Bundles leaving the open collection leave its grid at once, as in v0.2.1, and
  // come back if the change is refused. What each change will alter is read
  // first, so its Undo puts back exactly that.
  function changeBundles(
    moved: string[],
    target: string | null,
    source: string | null,
    text: string,
  ) {
    let changes: (MembershipChange | null)[] = []
    const settle = () =>
      setLeaving((current) => new Set([...current].filter((id) => !moved.includes(id))))
    const removes = source !== null && source !== target
    if (removes && source === selection.collectionId)
      setLeaving((current) => new Set([...current, ...moved]))
    run(
      async () => {
        changes = await Promise.all([
          ...(target ? [plannedChange(library, moved, 'collections', target, true)] : []),
          ...(removes ? [plannedChange(library, moved, 'collections', source, false)] : []),
        ])
        if (target) await moveBundlesToCollection(library, moved, target, source)
        else if (removes) await setCollectionMembership(library, moved, source, false)
      },
      () => {
        settle()
        undo.record(text, changes)
      },
      settle,
    )
  }
  const moveBundlesInto = (target: string, copy: boolean) => {
    // The live payload: a fast drop can arrive before React renders the drag
    const live = getActiveDrag() ?? dragItem
    if (live?.kind !== 'bundles' || live.ids.length === 0) return
    // Option/Alt adds; a plain drop out of an open collection moves
    const source = copy ? null : selection.collectionId
    const moves = source !== null && source !== target
    const name = names[target] ?? 'the collection'
    changeBundles(
      live.ids,
      target,
      source,
      `${moves ? 'Moved' : 'Added'} ${bundleCount(live.ids.length)} to “${name}”.`,
    )
  }
  const removeBundlesFromOpen = (ids: string[]) => {
    if (!selection.collectionId || !ids.length) return
    const name = names[selection.collectionId] ?? 'this collection'
    changeBundles(
      ids,
      null,
      selection.collectionId,
      membershipText('collections', name, false, ids.length),
    )
  }
  const dialogs = (
    <>
      {deleting && (
        <RemoveCollectionDialog
          collections={deleting}
          hasChildren={items.some((item) => deleting.some((gone) => item.parent_id === gone.id))}
          subcollectionsMoveUp
          pending={false}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const targets = deleting.map((item) => item.id)
            setDeleting(null)
            run(
              async () => {
                for (const target of targets) await remove(library, 'collections', target)
              },
              () => {
                if (selection.collectionId && targets.includes(selection.collectionId))
                  onSelect({ view: 'all', collectionId: null })
              },
            )
          }}
        />
      )}
      {cleaning && (
        <CleanupOrderDialog
          title="Clean up collection order"
          description="Overwrite the manual order of every collection level with alphabetical order by name."
          choices={[
            { key: 'asc', label: 'Title (A–Z)' },
            { key: 'desc', label: 'Title (Z–A)' },
          ]}
          pending={false}
          onCancel={() => setCleaning(false)}
          onConfirm={(key) => {
            setCleaning(false)
            run(() =>
              arrangeHierarchy(library, 'collections', (forest) =>
                sortCollectionsByName(forest, names, key as 'asc' | 'desc'),
              ),
            )
          }}
        />
      )}
    </>
  )
  return {
    items,
    error: collections.error,
    retry: () => void collections.refetch(),
    refresh,
    run,
    arrange,
    moveBundlesInto,
    removeBundlesFromOpen,
    leaving,
    requestDelete: setDeleting,
    requestCleanup: () => setCleaning(true),
    dialogs,
  }
}
