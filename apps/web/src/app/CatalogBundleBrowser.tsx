import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import type { components } from '../api/schema'
import type { BundleSort, SortOrder, BundleSummary } from '../api/client'
import { Browser, type BrowserNavigation } from './Browser'
import { Toolbar } from './Toolbar'
import { DEFAULT_PREFS, type Selection } from './types'
import { type AdHocFilters, adHocFiltersToExpression } from './adHocFilters'
import { useCollections } from '../api/hooks'
import { CatalogBundleInspector } from './CatalogBundleInspector'

type Page = components['schemas']['CatalogBrowsePage']
const supportedSorts: BundleSort[] = ['title', 'rating', 'date_added']

// The shared virtual listing and inspector controls receive catalog reads and causal saves.
export function CatalogBundleBrowser({
  library,
  selection,
  filters,
  onFilters,
  editor,
  inspectorEnabled,
  blocked,
  selected,
  onSelect,
  onReview,
  onOpen,
  onOpenFile,
}: {
  library: string
  filters: AdHocFilters
  onFilters: (filters: AdHocFilters) => void
  selection: Selection
  editor: string
  inspectorEnabled: boolean
  blocked: boolean
  selected: string | null
  onSelect: (id: string) => void
  onReview: () => void
  onOpen: (id: string) => void
  onOpenFile: (bundle: string, file: string) => void
}) {
  const collections = useCollections()
  const [includeDescendants, setIncludeDescendants] = useState(true)
  const expression = adHocFiltersToExpression(filters)
  const smart = useQuery({
    queryKey: ['catalog-detail', library, 'smart_folders', selection.smartCollectionId],
    enabled: Boolean(selection.smartCollectionId),
    queryFn: () =>
      catalog<Entity>(library, `/entities/smart_folders/${selection.smartCollectionId}`),
    refetchInterval: 2000,
  })
  const smartValue = smart.data?.fields.$filter?.value
  const smartFilter = smartValue ? JSON.parse(JSON.parse(smartValue).filter_json) : null
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState(DEFAULT_PREFS)
  const [sort, setSort] = useState<BundleSort>('title')
  const [order, setOrder] = useState<SortOrder>('asc')
  const activeSort = selection.view === 'recent' ? 'date_added' : sort
  const activeOrder = selection.view === 'recent' && sort !== 'date_added' ? 'desc' : order
  const [notice, setNotice] = useState('')
  const navigation = useRef<BrowserNavigation>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 200)
    return () => clearTimeout(timer)
  }, [search])
  const browse = useInfiniteQuery({
    queryKey: [
      'catalog-browse',
      library,
      query,
      sort,
      order,
      selection,
      includeDescendants,
      expression,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      catalog<Page>(library, '/bundles/browse', 'POST', {
        q: query,
        view: selection.view,
        collection_id: selection.collectionId,
        include_descendants: includeDescendants,
        smart_collection_id: selection.smartCollectionId ?? null,
        filter: expression,
        sort: activeSort,
        order: activeOrder,
        offset: pageParam,
        limit: 50,
      }),
    getNextPageParam: (page) =>
      page.offset + page.items.length < page.total ? page.offset + page.items.length : undefined,
    refetchInterval: 2000,
  })
  const items = useMemo(
    () =>
      browse.data?.pages.flatMap((page) =>
        page.items.map(
          (item) =>
            ({
              ...item,
              total_size: 0,
              has_missing: false,
              has_cover: Boolean(item.cover_file_id),
              openable: item.file_count > 0,
              cover_key: item.cover_key ?? null,
              cover_width: null,
              cover_height: null,
              primary_relative_path: null,
              resume_file_id: null,
              resume_file_updated_at: null,
              resume_media_kind: null,
              resume_relative_path: null,
              resume_mime_type: null,
              resume_container: null,
              resume_video_codec: null,
              resume_video_codec_tag: null,
              resume_audio_codec: null,
              resume_duration: null,
              resume_position: null,
              media_kind: null,
              width: null,
              height: null,
              duration: null,
              extension: null,
            }) satisfies BundleSummary,
        ),
      ) ?? [],
    [browse.data],
  )
  const detail = useQuery({
    queryKey: ['catalog-detail', library, 'asset_bundles', selected],
    enabled: Boolean(selected),
    queryFn: () => catalog<Entity>(library, `/entities/asset_bundles/${selected}`),
    refetchInterval: 2000,
  })
  const changeSort = (next: BundleSort, direction: SortOrder) => {
    if (!supportedSorts.includes(next)) {
      setNotice('This sort is not available for this library.')
      return
    }
    setNotice('')
    setSort(next)
    setOrder(direction)
  }
  const refresh = () => {
    void browse.refetch()
    void detail.refetch()
  }
  return (
    <div
      className="catalog-bundle-browser"
      onKeyDown={(event) => {
        if (!(event.target as HTMLElement).closest('[role="listbox"]')) return
        let next: string | null = null
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          next =
            navigation.current?.step(selected, event.key === 'ArrowDown' ? 'down' : 'up') ?? null
        if (event.key === 'Home') next = items[0]?.id ?? null
        if (event.key === 'End') next = items.at(-1)?.id ?? null
        if (event.key === 'Enter' && selected) {
          event.preventDefault()
          onOpen(selected)
        }
        if (next) {
          event.preventDefault()
          onSelect(next)
          navigation.current?.focus(next)
        }
      }}
    >
      <div className="center">
        <Toolbar
          allowCollectionSort={false}
          title={
            selection.collectionId
              ? (collections.data?.find((item) => item.id === selection.collectionId)?.name ??
                'Collection')
              : selection.smartCollectionId
                ? smart.data?.fields.name?.value
                  ? JSON.parse(smart.data.fields.name.value)
                  : 'Smart Collection'
                : selection.view === 'all'
                  ? 'All bundles'
                  : selection.view === 'uncategorized'
                    ? 'Uncategorized'
                    : selection.view === 'untagged'
                      ? 'Untagged'
                      : 'Recently added'
          }
          total={browse.data?.pages[0]?.total ?? 0}
          search={search}
          onSearch={setSearch}
          prefs={prefs}
          onPrefs={setPrefs}
          sort={activeSort}
          order={activeOrder}
          onSort={changeSort}
          allowedSorts={selection.view === 'recent' ? ['date_added'] : supportedSorts}
          perCollectionSort={false}
          onPerCollectionSort={() =>
            setNotice('Collection sorting is not available for this library.')
          }
          adHocFilters={filters}
          onAdHocFilters={onFilters}
          facetContext={{
            view: selection.view,
            collectionId: selection.collectionId,
            includeDescendants,
            q: query,
            smartFilter,
          }}
        />
        <p className="catalog-capabilities">
          File size and availability are unknown in bundle filters. Open Files or media to check
          local bytes.
        </p>
        {selection.collectionId && (
          <label>
            <input
              type="checkbox"
              checked={includeDescendants}
              onChange={(event) => setIncludeDescendants(event.target.checked)}
            />
            Show subcollection contents
          </label>
        )}
        {smart.error && <p role="alert">Saved conditions are unavailable.</p>}
        {notice && <p role="alert">{notice}</p>}
        {browse.error && (
          <button className="btn" onClick={() => void browse.refetch()}>
            Retry bundles
          </button>
        )}
        <Browser
          navigationRef={navigation}
          unavailableSize
          singleSelection
          items={items}
          total={browse.data?.pages[0]?.total ?? 0}
          layout={prefs.layout}
          zoom={prefs.zoom}
          sort={activeSort}
          order={activeOrder}
          onSort={changeSort}
          selectedIds={new Set(selected ? [selected] : [])}
          activeId={selected}
          onSelect={(id) => onSelect(id)}
          onMarqueeSelect={(ids) => {
            if (ids[0]) onSelect(ids[0])
          }}
          onOpen={onOpen}
          onContextMenu={(_, event) => {
            event.preventDefault()
            setNotice('Use the inspector to edit metadata or open conflict review.')
          }}
          isLoading={browse.isPending}
          isError={browse.isError}
          error={browse.error}
          hasNextPage={browse.hasNextPage}
          isFetchingNextPage={browse.isFetchingNextPage}
          fetchNextPage={() => void browse.fetchNextPage()}
          searchQuery={query}
        />
      </div>
      {detail.data && detail.data.fields.$alive?.value === 'true' ? (
        <CatalogBundleInspector
          key={`${library}/${selected}/${editor}`}
          library={library}
          entity={detail.data}
          editor={editor}
          inspectorEnabled={inspectorEnabled}
          blocked={blocked}
          refresh={refresh}
          onReview={onReview}
          onOpen={() => onOpen(detail.data.id)}
          onOpenFile={(file) => onOpenFile(detail.data.id, file)}
        />
      ) : (
        <aside className="inspector">
          <p>
            {detail.error
              ? 'Bundle details are unavailable.'
              : selected
                ? 'Waiting for bundle details. Deleted objects remain in metadata review.'
                : 'Select a bundle to see its details.'}
          </p>
          {detail.error && <button onClick={() => void detail.refetch()}>Retry details</button>}
        </aside>
      )}
    </div>
  )
}
