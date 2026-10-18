import { useQuery } from '@tanstack/react-query'
import { catalog } from '../api/catalog'
import { catalogNavigation } from '../api/catalogQuery'
import type { LibraryRead, SmartCollectionRead } from '../api/client'
import { createCollection, rename } from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import type { components } from '../api/schema'
import { useReplicaStatus } from '../api/useReplicaStatus'
import { getHostPlatform } from '../platform'
import type { CatalogNotice } from './CatalogToast'
import { buildDeepLinkUri, copyText } from './deepLinkUri'
import type { DragItem } from './dnd'
import { Sidebar } from './Sidebar'
import type { AppMode, Selection } from './types'
import type { CatalogCollections } from './useCatalogCollections'

type ViewCounts = components['schemas']['CatalogViewCounts']

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
  renameCollectionRequest = null,
  onRenameCollectionHandled,
  libraryActions,
  activity,
  collections,
  showSubContents,
  onNotice,
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
  /** A folder card's menu asks the sidebar to rename this collection in place. */
  renameCollectionRequest?: { id: string } | null
  onRenameCollectionHandled?: () => void
  /** Update and the library menu. */
  libraryActions?: React.ReactNode
  /** Running work and status that needs the owner, in the sidebar footer. */
  activity?: React.ReactNode
  collections: CatalogCollections
  /** A collection's badge counts its subtree only while the browser lists it. */
  showSubContents: boolean
  onNotice: (notice: CatalogNotice) => void
}) {
  const status = useReplicaStatus(library).data
  // Browse version 10 counts the system views, as the legacy sidebar did
  const counted = (status?.browse_version ?? 0) >= 10
  const counts = useQuery({
    queryKey: ['catalog-view-counts', library],
    enabled: counted,
    queryFn: () => catalog<ViewCounts>(library, '/bundles/counts'),
    refetchInterval: 5000,
  })
  const smart = useQuery({
    queryKey: ['catalog-navigation', library, 'smart_folders'],
    queryFn: () => catalogNavigation<SmartCollectionRead>(library, 'smart_folders'),
    refetchInterval: 2000,
  })
  const items = collections.items
  return (
    <>
      <Sidebar
        navigationOnly
        libraryActions={libraryActions}
        activity={activity}
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
        counts={counts.data}
        collections={items}
        collectionCounts={Object.fromEntries(
          items.map((item) => [
            item.id,
            showSubContents ? item.count : (item.direct_count ?? item.count),
          ]),
        )}
        collectionsEditable={!blocked}
        onCopyCollectionUri={
          getHostPlatform().kind === 'desktop'
            ? (id) =>
                void copyText(buildDeepLinkUri('collection', id, library)).then((copied) =>
                  onNotice(
                    copied
                      ? { text: 'Collection URI copied.' }
                      : { text: 'Could not copy the URI.', alert: true },
                  ),
                )
            : undefined
        }
        onDeleteCollection={(item) => collections.requestDelete([item])}
        onCreateCollection={(payload, callbacks) => {
          const current = captureRequestScope()
          const order = items
            .filter((item) => (item.parent_id ?? null) === payload.parent_id)
            .reduce((last, item) => Math.max(last, item.sort_order + 1), 0)
          void createCollection(library, payload.name, payload.parent_id, order)
            .then(async (created) => {
              current()
              await collections.refresh()
              callbacks.onSuccess(created)
            })
            .catch(callbacks.onError)
        }}
        onRenameCollection={(id, name, callbacks) => {
          const current = captureRequestScope()
          void rename(library, 'collections', id, name)
            .then(async () => {
              current()
              await collections.refresh()
              callbacks.onSuccess()
            })
            .catch(callbacks.onError)
        }}
        onReorderCollections={(parent, moved, before) => collections.arrange(moved, parent, before)}
        onReparentCollections={(moved, target) => collections.arrange(moved, target, null)}
        onCleanupCollections={collections.requestCleanup}
        renameCollectionRequest={renameCollectionRequest}
        onRenameCollectionHandled={onRenameCollectionHandled}
        dragItem={dragItem}
        onDragItem={onDragItem}
        newCollectionRequest={newCollectionRequest}
        onNewCollectionHandled={onNewCollectionHandled}
        onMoveBundlesInto={bundleMovesEnabled ? collections.moveBundlesInto : undefined}
        smartCollections={smart.data ?? []}
        onNewSmartCollection={onReview}
        onEditSmartCollection={(item) => onReviewEntity('smart_folders', item.id)}
        onDeleteSmartCollection={onReview}
        onOpenAllTags={() => onMode('tags')}
      />
      {collections.dialogs}
      {(collections.error || smart.error) && (
        <p role="alert">
          Navigation is unavailable.{' '}
          <button
            onClick={() => {
              collections.retry()
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
