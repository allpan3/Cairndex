import { useQuery } from '@tanstack/react-query'
import { catalogNavigation } from '../api/catalogQuery'
import type { CollectionRead, LibraryRead, SmartCollectionRead } from '../api/client'
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
        onDeleteCollection={onReview}
        onCreateCollection={onReview}
        onRenameCollection={onReview}
        onReorderCollections={onReview}
        smartCollections={smart.data ?? []}
        onNewSmartCollection={onReview}
        onEditSmartCollection={(item) => onReviewEntity('smart_folders', item.id)}
        onDeleteSmartCollection={onReview}
        onOpenAllTags={() => onMode('tags')}
      />
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
