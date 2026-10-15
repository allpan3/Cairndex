import { useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import { useReplicaStatus } from '../api/useReplicaStatus'
import type { components } from '../api/schema'
import type { BundleSort, SortOrder } from '../api/client'
import type { BundleCardItem } from './BundleCard'
import { Browser, type BrowserNavigation } from './Browser'
import { Toolbar } from './Toolbar'
import { DEFAULT_PREFS, type Selection } from './types'
import { type AdHocFilters, adHocFiltersToExpression } from './adHocFilters'
import { useCollections } from '../api/hooks'
import { CatalogMultiBundleInspector } from './CatalogMultiBundleInspector'
import { selectionRange, selectionTargets, type SelectionModifiers } from './selection'
import { CatalogBundleAlbum } from './CatalogBundleAlbum'
import { CatalogBundleInspector } from './CatalogBundleInspector'
import { CatalogBundleMoments } from './CatalogBundleMoments'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { catalogBundleHostPath, catalogBundleDragPaths } from '../desktop/catalogHostFiles'
import { ContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry } from './useContextMenu'
import { removeFromCollection, setCollectionCover } from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import { getHostPlatform } from '../platform'
import { buildDeepLinkUri, copyText } from './deepLinkUri'

type Page = components['schemas']['CatalogBrowsePage']
// Browse version 3 adds Manual and File count. A portable catalog records no file
// sizes, change times or opening times, so Size, Date Modified and Date Opened stay
// unavailable.
const BASIC_SORTS: BundleSort[] = ['title', 'rating', 'date_added']
const ORDERED_SORTS: BundleSort[] = [...BASIC_SORTS, 'manual', 'file_count']

// The shared virtual listing and inspector controls receive catalog reads and causal saves.
export function CatalogBundleBrowser({
  library,
  locateRequest,
  selection,
  filters,
  onFilters,
  editor,
  inspectorEnabled,
  albumEnabled,
  selectionEnabled,
  systemViewsEnabled,
  blocked,
  selected,
  onSelect,
  onReview,
  onOpen,
  onOpenFile,
  hostFiles,
  onHostPath,
  onLocateFile,
  viewerOpen = false,
}: {
  library: string
  locateRequest: number
  filters: AdHocFilters
  onFilters: (filters: AdHocFilters) => void
  selection: Selection
  editor: string
  selectionEnabled: boolean
  systemViewsEnabled: boolean
  albumEnabled: boolean
  inspectorEnabled: boolean
  blocked: boolean
  selected: string | null
  onSelect: (id: string) => void
  onReview: () => void
  onOpen: (id: string) => void
  /** Open one file in the viewer, at `time` seconds when it is given. */
  onOpenFile: (bundle: string, file: string, time?: number) => void
  hostFiles?: LibraryHostFiles
  onHostPath?: (path: string | null) => void
  /** Show one library-relative file in the File Browser. */
  onLocateFile?: (path: string) => void
  /** The viewer is open over this browser and shows the bundle inspector itself. */
  viewerOpen?: boolean
}) {
  const collections = useCollections()
  const client = useQueryClient()
  const status = useReplicaStatus(library).data
  const supportedSorts = (status?.browse_version ?? 0) >= 3 ? ORDERED_SORTS : BASIC_SORTS
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
  // Manual has no direction: the arrangement is the order, as in the legacy browser
  const activeOrder =
    activeSort === 'manual'
      ? 'asc'
      : selection.view === 'recent' && sort !== 'date_added'
        ? 'desc'
        : order
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2147483647))
  const [album, setAlbum] = useState<{ id: string; scope: string } | null>(null)
  const [albumFile, setAlbumFile] = useState<string | null>(null)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const menu = useContextMenu()
  const [inspectorFile, setInspectorFile] = useState<{ bundle: string; file: string } | null>(null)
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
      seed,
      expression,
    ],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      catalog<Page>(library, '/bundles/browse', 'POST', {
        q: query,
        ...(systemViewsEnabled ? { seed } : {}),
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
              has_missing: item.has_missing ?? false,
              has_cover: Boolean(item.cover_file_id),
              openable: item.file_count > 0,
              cover_key: item.cover_key ?? null,
              cover_width: null,
              cover_height: null,
              primary_relative_path: null,
              resume_file_id: item.resume_file_id ?? null,
              // The observed generation versions the file thumbnail URL
              resume_file_updated_at: item.resume_generation ?? null,
              resume_media_kind: item.resume_media_kind ?? null,
              resume_relative_path: item.resume_relative_path ?? null,
              resume_mime_type: item.resume_mime_type ?? null,
              resume_container: item.resume_container ?? null,
              resume_video_codec: item.resume_video_codec ?? null,
              resume_video_codec_tag: item.resume_video_codec_tag ?? null,
              resume_audio_codec: item.resume_audio_codec ?? null,
              resume_duration: item.resume_duration ?? null,
              resume_position: item.resume_position ?? null,
              resume_storyboard_version: item.resume_storyboard_version ?? null,
              media_kind: item.media_kind ?? null,
              width: item.width ?? null,
              height: item.height ?? null,
              duration: item.duration ?? null,
              extension: item.extension ?? null,
            }) satisfies BundleCardItem,
        ),
      ) ?? [],
    [browse.data],
  )
  const scope = JSON.stringify([
    library,
    query,
    sort,
    order,
    selection,
    includeDescendants,
    expression,
    seed,
  ])
  const [picked, setPicked] = useState({
    scope,
    ids: new Set(selected ? [selected] : []),
    active: selected,
    anchor: selected,
  })
  const outgoing = useRef(selected)
  const lastLocate = useRef(locateRequest)
  if (picked.scope !== scope) {
    setPicked({ scope, ids: new Set(), active: null, anchor: null })
    setAlbum(null)
    setAlbumFile(null)
  }
  useEffect(() => {
    if (selected !== outgoing.current || locateRequest !== lastLocate.current) {
      lastLocate.current = locateRequest
      outgoing.current = selected
      setPicked((current) => ({
        ...current,
        ids: new Set(selected ? [selected] : []),
        active: selected,
        anchor: selected,
      }))
      setBulkOpen(false)
      setAlbum(null)
      setAlbumFile(null)
    }
  }, [selected, locateRequest])
  const selectedIds = picked.scope === scope ? picked.ids : new Set<string>()
  const active = picked.scope === scope ? picked.active : null
  const albumId = album?.scope === scope ? album.id : null
  const single = albumId ?? (selectedIds.size === 1 ? [...selectedIds][0]! : null)
  const openAlbum = (id: string) => {
    if (!albumEnabled) {
      onOpen(id)
      return
    }
    setAlbum({ id, scope })
    setAlbumFile(null)
    setBulkOpen(false)
  }
  function select(id: string, modifiers: SelectionModifiers) {
    let ids = new Set([id])
    if (selectionEnabled && modifiers.shiftKey) {
      ids = selectionRange(
        items.map((item) => item.id),
        picked.anchor,
        id,
        modifiers.metaKey || modifiers.ctrlKey ? selectedIds : undefined,
      )
    } else if (selectionEnabled && (modifiers.metaKey || modifiers.ctrlKey)) {
      ids = new Set(selectedIds)
      if (ids.has(id)) ids.delete(id)
      else ids.add(id)
    }
    setPicked({ scope, ids, active: id, anchor: modifiers.shiftKey ? picked.anchor : id })
    outgoing.current = id
    onSelect(id)
    setBulkOpen(ids.size > 1)
  }
  function many(ids: string[]) {
    const active = ids.at(-1) ?? null
    setPicked({ scope, ids: new Set(ids), active, anchor: active })
    if (active) {
      outgoing.current = active
      onSelect(active)
    }
    setBulkOpen(ids.length > 1)
  }
  const detail = useQuery({
    queryKey: ['catalog-detail', library, 'asset_bundles', single],
    enabled: Boolean(single),
    queryFn: () => catalog<Entity>(library, `/entities/asset_bundles/${single}`),
    refetchInterval: 2000,
  })
  // Resolve one ordered member from metadata; host handoff also supports attachments.
  const hostTarget = useQuery({
    queryKey: ['catalog-host-target', library, single, albumId, albumFile, inspectorFile],
    enabled: Boolean(hostFiles?.mapped && single),
    queryFn: async () => {
      const pickedFile = albumId
        ? albumFile
        : inspectorFile?.bundle === single
          ? inspectorFile.file
          : null
      if (pickedFile) {
        const file = await catalog<Entity>(library, `/entities/asset_files/${pickedFile}`)
        return file.fields.$alive?.value === 'true' && file.fields.relative_path?.value
          ? (JSON.parse(file.fields.relative_path.value) as string)
          : null
      }
      if (albumId) return null
      return catalogBundleHostPath(library, single!)
    },
    refetchInterval: 2000,
  })
  const hostPath = hostTarget.isSuccess && single ? (hostTarget.data ?? null) : null
  useEffect(() => {
    onHostPath?.(hostPath)
  }, [hostPath, onHostPath])
  function hostAction(bundle: string, action: (paths: string[]) => void, drag = false) {
    const current = captureRequestScope()
    void (
      drag
        ? catalogBundleDragPaths(library, bundle)
        : catalogBundleHostPath(library, bundle).then((path) => (path ? [path] : []))
    )
      .then((paths) => {
        current()
        if (!paths.length) throw new Error('This bundle has no file.')
        action(paths)
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
  // A menu change saves at once; a reply after a library switch is dropped
  function organize(action: () => Promise<void>, done: string) {
    const current = captureRequestScope()
    setNotice('')
    void action()
      .then(async () => {
        current()
        setNotice(done)
        for (const key of ['catalog-browse', 'catalog-detail', 'catalog-memberships'])
          await client.invalidateQueries({ queryKey: [key, library] })
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
  // The legacy card menu: a card inside a multi-selection acts for the selection
  function bundleMenu(id: string, event: React.MouseEvent) {
    const targets = selectionEnabled ? selectionTargets(id, selectedIds) : [id]
    const one = targets.length === 1
    // A Control-click opens this menu on macOS, so it must not toggle the selection
    if (one) select(id, { shiftKey: false, metaKey: false, ctrlKey: false })
    const collection = selection.collectionId
    const items: MenuEntry[] = [{ label: 'Play / View', onClick: () => onOpen(id), disabled: !one }]
    if (albumEnabled)
      items.push({ label: 'Open Bundle', onClick: () => openAlbum(id), disabled: !one })
    // A browser has no handler for the scheme, so only the desktop app copies one
    if (one && getHostPlatform().kind === 'desktop')
      items.push({
        label: 'Copy URI',
        onClick: () =>
          void copyText(buildDeepLinkUri('bundle', id, library)).then((copied) =>
            setNotice(copied ? 'Bundle URI copied.' : 'Could not copy the URI.'),
          ),
      })
    if (one && onLocateFile)
      items.push(null, {
        label: 'Locate in File Browser',
        onClick: () => hostAction(id, (paths) => onLocateFile(paths[0]!)),
      })
    if (one && hostFiles?.onOpenFile)
      items.push({
        label: hostFiles.labels.openFile,
        onClick: () => hostAction(id, (paths) => hostFiles.onOpenFile!(paths[0]!)),
      })
    if (one && hostFiles?.onRevealFile)
      items.push({
        label: hostFiles.labels.revealFile,
        onClick: () => hostAction(id, (paths) => hostFiles.onRevealFile!(paths[0]!)),
      })
    if (collection) {
      items.push(null, {
        label: 'Set as Collection Cover',
        disabled: !one || blocked,
        onClick: () =>
          organize(() => setCollectionCover(library, collection, id), 'Collection cover set.'),
      })
      if ((status?.selection_version ?? 0) >= 2)
        items.push({
          label: one
            ? 'Remove from This Collection'
            : `Remove ${targets.length} from This Collection`,
          disabled: blocked || targets.length > 100,
          onClick: () =>
            organize(
              () => removeFromCollection(library, targets, collection),
              one
                ? 'Removed from this collection.'
                : `Removed ${targets.length} from this collection.`,
            ),
        })
    }
    items.push(null, { label: 'Review metadata and conflicts', onClick: onReview })
    menu.open(event, items)
  }
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
    if (single) void detail.refetch()
  }
  return (
    <div
      className="catalog-bundle-browser"
      onKeyDown={(event) => {
        if (!(event.target as HTMLElement).closest('[role="listbox"]')) return
        if (
          selectionEnabled &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'a'
        ) {
          event.preventDefault()
          many(items.map((item) => item.id))
          setNotice('Selected loaded bundles. Load more bundles to extend the selection.')
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          many([])
          return
        }
        let next: string | null = null
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
          next = navigation.current?.step(active, event.key === 'ArrowDown' ? 'down' : 'up') ?? null
        if (event.key === 'Home') next = items[0]?.id ?? null
        if (event.key === 'End') next = items.at(-1)?.id ?? null
        if (event.key === 'Enter' && single) {
          event.preventDefault()
          openAlbum(single)
        }
        if (next) {
          event.preventDefault()
          select(next, event)
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
                      : selection.view === 'random'
                        ? 'Random'
                        : selection.view === 'missing'
                          ? 'Missing Files'
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
          onReshuffle={
            selection.view === 'random'
              ? () => setSeed(Math.floor(Math.random() * 2147483647))
              : undefined
          }
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
        {!selectionEnabled && (
          <p>Update the server to use multiple selection and bulk metadata changes.</p>
        )}
        {selectionEnabled && !albumId && (
          <button className="btn catalog-bulk-open" onClick={() => setBulkOpen(true)}>
            Bulk changes ({selectedIds.size})
          </button>
        )}
        {selection.view === 'missing' && (
          <p>
            Last recorded local checks found unavailable files in these bundles. Unknown files are
            excluded. Open file details to check again.
          </p>
        )}
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
        <div hidden={Boolean(albumId)} className="catalog-album-browser-return">
          <Browser
            navigationRef={navigation}
            unavailableSize
            singleSelection={!selectionEnabled}
            items={items}
            total={browse.data?.pages[0]?.total ?? 0}
            layout={prefs.layout}
            zoom={prefs.zoom}
            sort={activeSort}
            order={activeOrder}
            onSort={changeSort}
            selectedIds={selectedIds}
            activeId={active}
            onSelect={select}
            onMarqueeSelect={many}
            onOpen={openAlbum}
            contextMenuOpen={menu.state !== null}
            onContextMenu={bundleMenu}
            isLoading={browse.isPending}
            isError={browse.isError}
            error={browse.error}
            hasNextPage={browse.hasNextPage}
            isFetchingNextPage={browse.isFetchingNextPage}
            fetchNextPage={() => void browse.fetchNextPage()}
            searchQuery={query}
          />
        </div>
        {albumId && (
          <CatalogBundleAlbum
            key={albumId}
            library={library}
            bundle={albumId}
            layout={prefs.layout}
            zoom={prefs.zoom}
            onBack={() => {
              setAlbum(null)
              setAlbumFile(null)
            }}
            onOpen={(file) => onOpenFile(albumId, file)}
            onSelectFile={setAlbumFile}
            hostFiles={hostFiles}
          />
        )}
      </div>
      {bulkOpen && selectionEnabled ? (
        <CatalogMultiBundleInspector
          key={`${library}/${editor}`}
          library={library}
          editor={editor}
          ids={[...selectedIds].sort()}
          blocked={blocked}
          onReview={onReview}
          onClose={() => setBulkOpen(false)}
        />
      ) : viewerOpen ? (
        // One inspector owns a bundle's drafts at a time, and the open viewer has it
        <aside className="inspector">
          <p>The bundle inspector is in the viewer.</p>
        </aside>
      ) : detail.data && detail.data.fields.$alive?.value === 'true' ? (
        <CatalogBundleInspector
          key={`${library}/${single}/${editor}`}
          library={library}
          entity={detail.data}
          editor={editor}
          hostFiles={hostFiles}
          onStartBundleDrag={
            hostFiles?.onStartFileDrag
              ? () => hostAction(detail.data.id, hostFiles.onStartFileDrag!, true)
              : undefined
          }
          onSelectHostFile={(file) =>
            setInspectorFile(file ? { bundle: detail.data.id, file } : null)
          }
          inspectorEnabled={inspectorEnabled}
          blocked={blocked}
          refresh={refresh}
          onReview={onReview}
          albumFile={albumId ? albumFile : null}
          onAlbum={albumEnabled ? () => openAlbum(detail.data.id) : undefined}
          onOpen={() => onOpen(detail.data.id)}
          onOpenFile={(file) => onOpenFile(detail.data.id, file)}
          moments={
            <CatalogBundleMoments
              library={library}
              bundle={detail.data.id}
              onPlay={(file, time) => onOpenFile(detail.data.id, file, time)}
            />
          }
        />
      ) : (
        <aside className="inspector">
          <p>
            {detail.error
              ? 'Bundle details are unavailable.'
              : single
                ? 'Waiting for bundle details. Deleted objects remain in metadata review.'
                : 'Select a bundle to see its details.'}
          </p>
          {detail.error && <button onClick={() => void detail.refetch()}>Retry details</button>}
        </aside>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  )
}
