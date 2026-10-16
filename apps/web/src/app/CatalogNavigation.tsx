import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { catalogNavigation } from '../api/catalogQuery'
import type { CollectionRead, LibraryRead, SmartCollectionRead } from '../api/client'
import {
  arrangeCollections,
  createCollection,
  deleteCollection,
  moveBundlesToCollection,
  moveCollections,
  renameCollection,
  sortCollectionsByName,
} from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import { getHostPlatform } from '../platform'
import { CleanupOrderDialog } from './CleanupOrderDialog'
import { buildDeepLinkUri, copyText } from './deepLinkUri'
import { getActiveDrag, type DragItem } from './dnd'
import { RemoveCollectionDialog } from './RemoveCollectionDialog'
import { Sidebar } from './Sidebar'
import type { AppMode, Selection } from './types'

export function CatalogNavigation({
  systemViewsEnabled,
  unbundled,
  onUnbundled,
  library,
  libraries,
  selection,
  mode,
  onMode,
  onSelect,
  onChangeLibrary,
  onManage,
  onSettings,
  onReview,
  onReviewEntity,
  blocked,
  dragItem = null,
  onDragItem,
  bundleMovesEnabled = false,
  newCollectionRequest = null,
  onNewCollectionHandled,
}: {
  systemViewsEnabled: boolean
  unbundled: boolean
  onUnbundled: () => void
  library: string
  libraries: LibraryRead[]
  selection: Selection
  mode: AppMode
  onMode: (mode: AppMode) => void
  onSelect: (selection: Selection) => void
  onChangeLibrary: (id: string) => void
  onManage: () => void
  onSettings?: () => void
  onReviewEntity: (family: string, id: string) => void
  onReview: () => void
  /** The catalog is not ready, or recovery holds it; collections stay read-only. */
  blocked: boolean
  /** A drag in progress, from the browser or the sidebar itself. */
  dragItem?: DragItem | null
  onDragItem?: (item: DragItem | null) => void
  /** Cards dropped on a collection join it; needs `selection_version: 2`. */
  bundleMovesEnabled?: boolean
  /** The browser's empty-space menu asks for a new collection here. */
  newCollectionRequest?: { parentId: string | null } | null
  onNewCollectionHandled?: () => void
}) {
  const collections = useQuery({
    queryKey: ['catalog-navigation', library, 'collections'],
    queryFn: () => catalogNavigation<CollectionRead & { count: number }>(library, 'collections'),
    refetchInterval: 2000,
  })
  const smart = useQuery({
    queryKey: ['catalog-navigation', library, 'smart_folders'],
    queryFn: () => catalogNavigation<SmartCollectionRead>(library, 'smart_folders'),
    refetchInterval: 2000,
  })
  const client = useQueryClient()
  const [notice, setNotice] = useState('')
  const [deleting, setDeleting] = useState<CollectionRead | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const items = collections.data ?? []
  const names = Object.fromEntries(items.map((item) => [item.id, item.name]))
  const refresh = async () => {
    for (const key of [
      'catalog-navigation',
      'catalog-browse',
      'catalog-detail',
      'catalog-memberships',
    ])
      await client.invalidateQueries({ queryKey: [key, library] })
  }
  // Each change saves at once; a reply after a library switch is dropped
  function run(action: () => Promise<void>, done?: () => void) {
    const current = captureRequestScope()
    setNotice('')
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
        setNotice(reason.message)
      })
  }
  const arrange = (moved: string[], parent: string | null, before: string | null) =>
    run(() =>
      arrangeCollections(library, (forest) =>
        moveCollections(forest, names, moved, parent, before),
      ),
    )
  return (
    <>
      <Sidebar
        navigationOnly
        availableViews={
          systemViewsEnabled
            ? ['all', 'uncategorized', 'untagged', 'recent', 'random', 'missing', 'unbundled']
            : ['all', 'uncategorized', 'untagged', 'recent']
        }
        fileScope={unbundled ? 'unbundled' : 'browse'}
        onOpenUnbundled={onUnbundled}
        mode={mode}
        onMode={onMode}
        libraries={libraries}
        libraryId={library}
        onChangeLibrary={onChangeLibrary}
        onManageLibraries={onManage}
        onOpenSettings={onSettings ?? onManage}
        onUpdateLibrary={onReview}
        onScanFiles={onReview}
        onProbe={onReview}
        onGenerateStoryboards={onReview}
        onReviewGrouping={onReview}
        selection={selection}
        onSelect={onSelect}
        collections={collections.data ?? []}
        collectionCounts={Object.fromEntries(
          (collections.data ?? []).map((item) => [item.id, item.count]),
        )}
        collectionsEditable={!blocked}
        onCopyCollectionUri={
          getHostPlatform().kind === 'desktop'
            ? (id) =>
                void copyText(buildDeepLinkUri('collection', id, library)).then((copied) =>
                  setNotice(copied ? 'Collection URI copied.' : 'Could not copy the URI.'),
                )
            : undefined
        }
        onDeleteCollection={setDeleting}
        onCreateCollection={(payload, callbacks) => {
          const current = captureRequestScope()
          const order = items
            .filter((item) => (item.parent_id ?? null) === payload.parent_id)
            .reduce((last, item) => Math.max(last, item.sort_order + 1), 0)
          void createCollection(library, payload.name, payload.parent_id, order)
            .then(async (created) => {
              current()
              await refresh()
              callbacks.onSuccess(created)
            })
            .catch(callbacks.onError)
        }}
        onRenameCollection={(id, name, callbacks) => {
          const current = captureRequestScope()
          void renameCollection(library, id, name)
            .then(async () => {
              current()
              await refresh()
              callbacks.onSuccess()
            })
            .catch(callbacks.onError)
        }}
        onReorderCollections={(parent, moved, before) => arrange(moved, parent, before)}
        onReparentCollections={(moved, target) => arrange(moved, target, null)}
        onCleanupCollections={() => setCleaning(true)}
        dragItem={dragItem}
        onDragItem={onDragItem}
        newCollectionRequest={newCollectionRequest}
        onNewCollectionHandled={onNewCollectionHandled}
        onMoveBundlesInto={
          bundleMovesEnabled
            ? (target, copy) => {
                // The live payload: a fast drop can arrive before React renders the drag
                const live = getActiveDrag() ?? dragItem
                if (live?.kind !== 'bundles' || live.ids.length === 0) return
                // Option/Alt adds; a plain drop out of an open collection moves
                const source = copy ? null : selection.collectionId
                run(() => moveBundlesToCollection(library, live.ids, target, source))
              }
            : undefined
        }
        smartCollections={smart.data ?? []}
        onNewSmartCollection={onReview}
        onEditSmartCollection={(item) => onReviewEntity('smart_folders', item.id)}
        onDeleteSmartCollection={onReview}
        onOpenAllTags={() => onMode('tags')}
      />
      {notice && (
        <p role="alert">
          {notice} <button onClick={() => setNotice('')}>Dismiss</button>
        </p>
      )}
      {deleting && (
        <RemoveCollectionDialog
          collections={[deleting]}
          hasChildren={items.some((item) => item.parent_id === deleting.id)}
          subcollectionsMoveUp
          pending={false}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const target = deleting.id
            setDeleting(null)
            run(
              () => deleteCollection(library, target),
              () => {
                if (selection.collectionId === target) onSelect({ view: 'all', collectionId: null })
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
              arrangeCollections(library, (forest) =>
                sortCollectionsByName(forest, names, key as 'asc' | 'desc'),
              ),
            )
          }}
        />
      )}
      {(collections.error || smart.error) && (
        <p role="alert">
          Navigation is unavailable.{' '}
          <button
            onClick={() => {
              void collections.refetch()
              void smart.refetch()
            }}
          >
            Retry navigation
          </button>
        </p>
      )}
    </>
  )
}
