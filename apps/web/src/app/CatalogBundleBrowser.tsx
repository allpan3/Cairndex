import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import type { components } from '../api/schema'
import type { BundleSort, SortOrder, BundleSummary } from '../api/client'
import { Browser, type BrowserNavigation } from './Browser'
import { Toolbar } from './Toolbar'
import { DEFAULT_PREFS } from './types'
import { emptyAdHocFilters } from './adHocFilters'
import { CatalogBundleInspector } from './CatalogBundleInspector'

type Page = components['schemas']['CatalogBrowsePage']
const supportedSorts: BundleSort[] = ['title', 'rating', 'date_added']

// The shared virtual listing and inspector controls receive catalog reads and causal saves.
export function CatalogBundleBrowser({
  library,
  editor,
  blocked,
  selected,
  onSelect,
  onReview,
  onOpen,
}: {
  library: string
  editor: string
  blocked: boolean
  selected: string | null
  onSelect: (id: string) => void
  onReview: () => void
  onOpen: (id: string) => void
}) {
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [prefs, setPrefs] = useState(DEFAULT_PREFS)
  const [sort, setSort] = useState<BundleSort>('title')
  const [order, setOrder] = useState<SortOrder>('asc')
  const [notice, setNotice] = useState('')
  const navigation = useRef<BrowserNavigation>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 200)
    return () => clearTimeout(timer)
  }, [search])
  const browse = useInfiniteQuery({
    queryKey: ['catalog-browse', library, query, sort, order],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      catalog<Page>(library, '/bundles/browse', 'POST', {
        q: query,
        sort,
        order,
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
              has_cover: false,
              openable: item.file_count > 0,
              cover_key: null,
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
          title="All bundles"
          total={browse.data?.pages[0]?.total ?? 0}
          search={search}
          onSearch={setSearch}
          prefs={prefs}
          onPrefs={setPrefs}
          sort={sort}
          order={order}
          onSort={changeSort}
          allowedSorts={supportedSorts}
          perCollectionSort={false}
          onPerCollectionSort={() =>
            setNotice('Collection sorting is not available for this library.')
          }
          adHocFilters={emptyAdHocFilters()}
          onAdHocFilters={() => {}}
          facetContext={{
            view: 'all',
            collectionId: null,
            includeDescendants: true,
            q: query,
            smartFilter: null,
          }}
          unavailableFilters="Structured filters are not available for this library."
        />
        <p className="catalog-capabilities">
          Search covers bundle names, notes, file notes and moment comments. Structured filters,
          cover previews and file sizes are not yet available here.
        </p>
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
          sort={sort}
          order={order}
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
          blocked={blocked}
          refresh={refresh}
          onReview={onReview}
          onOpen={() => onOpen(detail.data.id)}
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
