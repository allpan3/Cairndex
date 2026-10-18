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
  sortCollectionsByName,
} from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import type { CatalogNotice } from './CatalogToast'
import { CleanupOrderDialog } from './CleanupOrderDialog'
import { getActiveDrag, type DragItem } from './dnd'
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
  }: {
    selection: Selection
    onSelect: (selection: Selection) => void
    onNotice: (notice: CatalogNotice) => void
    dragItem: DragItem | null
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
  const items = collections.data ?? []
  const names = Object.fromEntries(items.map((item) => [item.id, item.name]))
  const refresh = async () => {
    for (const key of [
      'catalog-navigation',
      'catalog-browse',
      'catalog-detail',
      'catalog-memberships',
      'catalog-view-counts',
    ])
      await client.invalidateQueries({ queryKey: [key, library] })
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
        onNotice({ text: reason.message, alert: true })
        failed?.()
      })
  }
  const arrange = (moved: string[], parent: string | null, before: string | null) =>
    run(() =>
      arrangeHierarchy(library, 'collections', (forest) =>
        moveCollections(forest, names, moved, parent, before),
      ),
    )
  const moveBundlesInto = (target: string, copy: boolean) => {
    // The live payload: a fast drop can arrive before React renders the drag
    const live = getActiveDrag() ?? dragItem
    if (live?.kind !== 'bundles' || live.ids.length === 0) return
    // Option/Alt adds; a plain drop out of an open collection moves
    const source = copy ? null : selection.collectionId
    run(() => moveBundlesToCollection(library, live.ids, target, source))
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
    requestDelete: setDeleting,
    requestCleanup: () => setCleaning(true),
    dialogs,
  }
}
