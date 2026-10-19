import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { catalog, type Entity } from '../api/catalog'
import { useReplicaStatus } from '../api/useReplicaStatus'
import type { components } from '../api/schema'
import type { BundleSort, SortOrder } from '../api/client'
import type { BundleCardItem } from './BundleCard'
import { Browser, type BrowserNavigation } from './Browser'
import { Toolbar } from './Toolbar'
import {
  type BrowsePrefs,
  DEFAULT_PREFS,
  type Selection,
  type SortPref,
  SYSTEM_VIEWS,
  RECENT_SORTS,
} from './types'
import { usePersistentState } from '../state/usePersistentState'
import { ZOOM_MAX, ZOOM_MIN } from './layout'
import {
  type AdHocFilters,
  adHocFiltersToExpression,
  anyAdHocActive,
  emptyAdHocFilters,
} from './adHocFilters'
import { CatalogMultiBundleInspector } from './CatalogMultiBundleInspector'
import { selectionRange, selectionTargets, type SelectionModifiers } from './selection'
import { CatalogBundleAlbum } from './CatalogBundleAlbum'
import { CatalogBundleInspector } from './CatalogBundleInspector'
import { CatalogBundleMoments } from './CatalogBundleMoments'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { catalogBundleHostPath, catalogBundleDragPaths } from '../desktop/catalogHostFiles'
import { ContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry } from './useContextMenu'
import {
  cleanUpBundleOrder,
  deleteBundles,
  reorderBundles,
  setCollectionCover,
  setCollectionMembership,
} from '../api/catalogOrganize'
import { captureRequestScope } from '../api/requestScope'
import { draftKey } from '../api/replicas'
import { getHostPlatform } from '../platform'
import { buildDeepLinkUri, copyText } from './deepLinkUri'
import { CleanupOrderDialog } from './CleanupOrderDialog'
import { DeleteBundlesDialog } from './DeleteBundlesDialog'
import { AddFilesToBundleDialog, CreateEmptyBundleDialog } from './ManualBundlingDialogs'
import { CatalogCollectionInspector } from './CatalogCollectionInspector'
import type { CatalogNotice } from './CatalogToast'
import { CollectionHeader } from './CollectionHeader'
import { useDesktopMenu } from '../desktop/useDesktopMenu'
import type { DragItem } from './dnd'
import type { CatalogCollection, CatalogCollections } from './useCatalogCollections'
import { useCatalogTagClipboard } from './useCatalogTagClipboard'
import { copiedCatalogTags } from '../api/catalogTagClipboard'
import { navTargetsFrom, rowStep } from './spatialNav'

type Page = components['schemas']['CatalogBrowsePage']
// Browse version 11 adds local file observations and opening/edit history.
const BASIC_SORTS: BundleSort[] = ['title', 'rating', 'date_added']
const ORDERED_SORTS: BundleSort[] = [...BASIC_SORTS, 'manual', 'file_count']
const LOCAL_SORTS: BundleSort[] = [...ORDERED_SORTS, 'size', 'date_modified', 'date_opened']
const NO_IDS: ReadonlySet<string> = new Set()

// A prepared bulk review or an interrupted save owns its own targets, so it
// stays open (and reopens after a reload) once the selection it came from is gone
function pendingBulkSave(library: string, editor: string): boolean {
  try {
    const raw = localStorage.getItem(draftKey(library, 'bulk', editor))
    return Boolean(raw && (JSON.parse(raw) as { body?: { operation?: string } }).body?.operation)
  } catch {
    return false
  }
}

/**
 * The folder cards above the grid, as in v0.2.1: All shows the top-level
 * collections; an open collection shows its children, or every descendant in
 * tree order while its contents include them. Other views show none.
 */
function folderCards(
  all: CatalogCollection[],
  parent: string | null,
  topLevel: boolean,
  flattened: boolean,
): CatalogCollection[] {
  if (parent === null && !topLevel) return []
  const byOrder = (a: CatalogCollection, b: CatalogCollection) =>
    a.sort_order - b.sort_order || a.name.localeCompare(b.name)
  const children = (id: string | null) =>
    all.filter((item) => (item.parent_id ?? null) === id).sort(byOrder)
  if (!flattened || parent === null) return children(parent)
  const flat: CatalogCollection[] = []
  const walk = (id: string) => {
    for (const child of children(id)) {
      flat.push(child)
      walk(child.id)
    }
  }
  walk(parent)
  return flat
}

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
  onOpenDirectory,
  onBundleDrag,
  onNewCollection,
  viewerOpen = false,
  collections,
  showSubContents,
  onShowSubContents,
  onOpenCollection,
  onRenameCollection,
  dragItem,
  onDragItem,
  bundleMovesEnabled,
  onNotice,
  headerLeading,
  headerTrailing,
  onScreen = true,
  onFilterTag,
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
  onOpenDirectory?: (path: string) => void
  /** Cards drag into sidebar collections when set; `null` ends the drag. */
  onBundleDrag?: (ids: string[] | null) => void
  /** Start naming a new collection under `parent` (null: the top level). */
  onNewCollection?: (parent: string | null) => void
  /** The viewer is open over this browser and shows the bundle inspector itself. */
  viewerOpen?: boolean
  collections: CatalogCollections
  /** An open collection lists its subcollections' bundles too, as v0.2.1's switch did. */
  showSubContents: boolean
  onShowSubContents: (value: boolean) => void
  onOpenCollection: (id: string) => void
  /** A folder card's Rename asks the sidebar to rename in place. */
  onRenameCollection: (id: string) => void
  dragItem: DragItem | null
  onDragItem: (item: DragItem | null) => void
  /** Bundles dropped on a folder card join it; needs `selection_version: 2`. */
  bundleMovesEnabled: boolean
  onNotice: (notice: CatalogNotice) => void
  /** Back/Forward, ahead of the toolbar's title. */
  headerLeading?: ReactNode
  /** The inspector's toggle, at the toolbar's far end. */
  headerTrailing?: ReactNode
  /** On screen; the View menu's zoom applies only then. */
  onScreen?: boolean
  onFilterTag?: (id: string) => void
}) {
  const status = useReplicaStatus(library).data
  const localHistoryEnabled = (status?.browse_version ?? 0) >= 11
  const supportedSorts = localHistoryEnabled
    ? LOCAL_SORTS
    : (status?.browse_version ?? 0) >= 3
      ? ORDERED_SORTS
      : BASIC_SORTS
  const includeDescendants = Boolean(selection.collectionId) && showSubContents
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
  // v0.2.1's stored preferences, so layout, zoom and sort survive a restart
  const [storedPrefs, setPrefs] = usePersistentState<BrowsePrefs>('cairndex.prefs', DEFAULT_PREFS, {
    debounceMs: 300,
  })
  const prefs = useMemo(
    () => ({
      ...DEFAULT_PREFS,
      ...storedPrefs,
      zoom: Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, storedPrefs.zoom ?? DEFAULT_PREFS.zoom)),
    }),
    [storedPrefs],
  )
  // With "remember per collection" each collection or view keeps its own sort
  const sortKey = selection.smartCollectionId
    ? `smart:${selection.smartCollectionId}`
    : selection.collectionId
      ? `coll:${selection.collectionId}`
      : `view:${selection.view}`
  const allowedSorts: BundleSort[] =
    selection.view === 'recent'
      ? RECENT_SORTS.filter((sort) => supportedSorts.includes(sort))
      : supportedSorts
  const stored: SortPref =
    prefs.sortScope === 'collection'
      ? (prefs.collectionSorts[sortKey] ?? { sort: prefs.sort, order: prefs.order })
      : { sort: prefs.sort, order: prefs.order }
  // A sort this view or server cannot run falls back as v0.2.1 did: Recent to
  // newest first, everything else to Manual, or Title before Manual existed
  const resolved: SortPref = allowedSorts.includes(stored.sort)
    ? stored
    : selection.view === 'recent'
      ? { sort: 'date_added', order: 'desc' }
      : { sort: allowedSorts.includes('manual') ? 'manual' : 'title', order: 'asc' }
  const activeSort = resolved.sort
  // Manual has no direction: the arrangement is the order, as in the legacy browser
  const activeOrder: SortOrder = activeSort === 'manual' ? 'asc' : resolved.order
  const [seed, setSeed] = useState(() => Math.floor(Math.random() * 2147483647))
  const [album, setAlbum] = useState<{ id: string; scope: string } | null>(null)
  const [albumFile, setAlbumFile] = useState<string | null>(null)
  const [bulkRetained, setBulkRetained] = useState(() => pendingBulkSave(library, editor))
  const [deleting, setDeleting] = useState<string[] | null>(null)
  const [cleaning, setCleaning] = useState(false)
  const [creatingBundle, setCreatingBundle] = useState(false)
  const [addingFiles, setAddingFiles] = useState<{ id: string; title: string | null } | null>(null)
  const menu = useContextMenu()
  const [inspectorFile, setInspectorFile] = useState<{ bundle: string; file: string } | null>(null)
  const navigation = useRef<BrowserNavigation>(null)
  const browserRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search), 200)
    return () => clearTimeout(timer)
  }, [search])
  const browse = useInfiniteQuery({
    queryKey: [
      'catalog-browse',
      library,
      query,
      activeSort,
      activeOrder,
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
              total_size: item.total_size ?? 0,
              size_known: localHistoryEnabled && item.total_size != null,
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
    [browse.data, localHistoryEnabled],
  )
  const scope = JSON.stringify([
    library,
    query,
    activeSort,
    activeOrder,
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
  // Folder cards select apart from bundles: acting on both at once means nothing
  const [pickedFolders, setPickedFolders] = useState({
    scope,
    ids: NO_IDS,
    anchor: null as string | null,
    active: null as string | null,
  })
  if (picked.scope !== scope) {
    setPicked({ scope, ids: new Set(), active: null, anchor: null })
    setAlbum(null)
    setAlbumFile(null)
  }
  const folderIds = pickedFolders.scope === scope ? pickedFolders.ids : NO_IDS
  const clearFolders = () => setPickedFolders({ scope, ids: NO_IDS, anchor: null, active: null })
  useEffect(() => {
    if (selected !== outgoing.current || locateRequest !== lastLocate.current) {
      lastLocate.current = locateRequest
      setSearch('')
      setQuery('')
      outgoing.current = selected
      setPicked((current) => ({
        ...current,
        ids: new Set(selected ? [selected] : []),
        active: selected,
        anchor: selected,
      }))
      setAlbum(null)
      setAlbumFile(null)
    }
  }, [selected, locateRequest])
  const selectedIds = useMemo(
    () => (picked.scope === scope ? picked.ids : new Set<string>()),
    [picked.scope, picked.ids, scope],
  )
  const active = picked.scope === scope ? picked.active : null
  const selectedCards = useMemo(
    () => items.filter((item) => selectedIds.has(item.id)),
    [items, selectedIds],
  )
  const albumId = album?.scope === scope ? album.id : null
  const clipboard = useCatalogTagClipboard(library, onNotice)
  useEffect(() => {
    if (
      !onScreen ||
      viewerOpen ||
      albumId ||
      (status?.selection_version ?? 0) < 2 ||
      getHostPlatform().kind !== 'desktop'
    )
      return
    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        !event.shiftKey ||
        document.querySelector('[aria-modal="true"], [role="menu"]')
      )
        return
      if (event.key.toLowerCase() === 'c' && active) {
        event.preventDefault()
        void clipboard.copy(active)
      } else if (
        event.key.toLowerCase() === 'v' &&
        !blocked &&
        selectedIds.size &&
        copiedCatalogTags(library).length
      ) {
        event.preventDefault()
        void clipboard.paste([...selectedIds])
      }
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [
    onScreen,
    viewerOpen,
    albumId,
    active,
    selectedIds,
    blocked,
    library,
    clipboard,
    status?.selection_version,
  ])
  const single = albumId ?? (selectedIds.size === 1 ? [...selectedIds][0]! : null)
  // A selected card's collection, else the open one when nothing else is picked
  const inspectedFolder =
    folderIds.size === 1 ? (collections.items.find((item) => folderIds.has(item.id)) ?? null) : null
  const openFolder =
    selectedIds.size === 0 && folderIds.size === 0 && selection.collectionId
      ? (collections.items.find((item) => item.id === selection.collectionId) ?? null)
      : null
  const openAlbum = (id: string) => {
    if (!albumEnabled) {
      onOpen(id)
      return
    }
    setAlbum({ id, scope })
    setAlbumFile(null)
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
    clearFolders()
    outgoing.current = id
    onSelect(id)
  }
  function many(ids: string[]) {
    const active = ids.at(-1) ?? null
    setPicked({ scope, ids: new Set(ids), active, anchor: active })
    if (ids.length > 0) clearFolders()
    if (active) {
      outgoing.current = active
      onSelect(active)
    }
  }
  const isAll = selection.view === 'all' && !selection.collectionId && !selection.smartCollectionId
  const folders = useMemo(
    () => folderCards(collections.items, selection.collectionId ?? null, isAll, includeDescendants),
    [collections.items, selection.collectionId, isAll, includeDescendants],
  )
  const subcounts = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const item of collections.items)
      if (item.parent_id) counts[item.parent_id] = (counts[item.parent_id] ?? 0) + 1
    return counts
  }, [collections.items])
  const [foldersFolded, setFoldersFolded] = useState(false)
  const [contentsFolded, setContentsFolded] = useState(false)
  // Cmd toggles and Shift extends, as in v0.2.1; Ctrl-click is the macOS menu chord
  function pickFolders(
    ids: ReadonlySet<string>,
    anchor: string | null,
    active = [...ids].at(-1) ?? null,
  ) {
    setPickedFolders({ scope, ids, anchor, active })
    if (ids.size > 0) setPicked({ scope, ids: new Set(), active: null, anchor: null })
  }
  function selectFolder(id: string, modifiers: SelectionModifiers) {
    const anchor = pickedFolders.scope === scope ? pickedFolders.anchor : null
    if (modifiers.shiftKey && anchor) {
      const order = folders.map((item) => item.id)
      return pickFolders(
        selectionRange(order, anchor, id, modifiers.metaKey ? folderIds : undefined),
        anchor,
        id,
      )
    }
    if (modifiers.metaKey) {
      const ids = new Set(folderIds)
      if (ids.has(id)) ids.delete(id)
      else ids.add(id)
      return pickFolders(ids, id)
    }
    pickFolders(new Set([id]), id)
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
        onNotice({ text: reason.message, alert: true })
      })
  }
  // A menu change saves at once and refreshes every count it can move
  const organize = (action: () => Promise<void>, done: string) =>
    collections.run(action, () => done && onNotice({ text: done }))
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
            onNotice(
              copied
                ? { text: 'Bundle URI copied.' }
                : { text: 'Could not copy the URI.', alert: true },
            ),
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
              () => setCollectionMembership(library, targets, collection, false),
              one
                ? 'Removed from this collection.'
                : `Removed ${targets.length} from this collection.`,
            ),
        })
    }
    items.push(null, { label: 'Review metadata and conflicts', onClick: onReview })
    if ((status?.browse_version ?? 0) >= 5)
      items.push(null, {
        label: one ? 'Delete Bundle' : `Delete ${targets.length} Bundles`,
        danger: true,
        disabled: blocked || targets.length > 100,
        onClick: () => setDeleting(targets),
      })
    menu.open(event, items)
  }
  // v0.2.1's folder card menu; a card inside a multi-selection acts for all of it
  function folderMenu(id: string, event: React.MouseEvent) {
    const targets = selectionTargets(id, folderIds)
    if (targets.length === 1) pickFolders(new Set([id]), id)
    const entries: MenuEntry[] = []
    if (targets.length === 1 && getHostPlatform().kind === 'desktop')
      entries.push(
        {
          label: 'Copy URI',
          onClick: () =>
            void copyText(buildDeepLinkUri('collection', id, library)).then((copied) =>
              onNotice(
                copied
                  ? { text: 'Collection URI copied.' }
                  : { text: 'Could not copy the URI.', alert: true },
              ),
            ),
        },
        null,
      )
    if (targets.length === 1)
      entries.push(
        { label: 'Rename Collection', disabled: blocked, onClick: () => onRenameCollection(id) },
        null,
      )
    entries.push({
      label: targets.length > 1 ? `Delete ${targets.length} Collections` : 'Delete Collection',
      danger: true,
      disabled: blocked,
      onClick: () =>
        collections.requestDelete(collections.items.filter((item) => targets.includes(item.id))),
    })
    menu.open(event, entries)
  }
  // One collection's own bundles, or All bundles, have a manual order; a view of
  // several collections or a shuffle does not, so neither offers to rewrite it
  const ordering = (status?.browse_version ?? 0) >= 6 && !blocked
  const bundling = (status?.browse_version ?? 0) >= 9 && !blocked
  useDesktopMenu((action) => {
    if ((action === 'zoom-in' || action === 'zoom-out') && onScreen)
      setPrefs((previous) => ({
        ...previous,
        zoom: Math.max(
          ZOOM_MIN,
          Math.min(
            ZOOM_MAX,
            (previous.zoom ?? DEFAULT_PREFS.zoom) + (action === 'zoom-in' ? 10 : -10),
          ),
        ),
      }))
    // The workspace shows the bundles first, so this is not limited to `onScreen`
    else if (action === 'new-bundle' && bundling) setCreatingBundle(true)
  })
  const scoped = !(selection.collectionId && includeDescendants) && selection.view !== 'random'
  const reorder =
    ordering && scoped && activeSort === 'manual'
      ? ({ movedIds, beforeId }: { movedIds: string[]; beforeId: string | null }) =>
          organize(
            () => reorderBundles(library, selection.collectionId ?? null, movedIds, beforeId),
            '',
          )
      : undefined
  // Empty space means "here": under the open collection, else at the top level
  const emptyMenu = (event: React.MouseEvent) => {
    const parent = selection.collectionId ?? null
    const entries: MenuEntry[] = []
    if (onNewCollection && !blocked)
      entries.push({
        label: parent ? 'New Subcollection' : 'New Collection',
        onClick: () => onNewCollection(parent),
      })
    // As in v0.2.1, an empty bundle comes first and its files are added next
    if (bundling) entries.push({ label: 'Create Bundle…', onClick: () => setCreatingBundle(true) })
    if (ordering)
      entries.push(null, {
        label: 'Clean Up Order…',
        disabled: !scoped,
        onClick: () => setCleaning(true),
      })
    if (entries.some(Boolean)) menu.open(event, entries)
  }
  const changeSort = (next: BundleSort, direction: SortOrder) => {
    if (!allowedSorts.includes(next)) {
      onNotice({ text: 'This sort is not available here.', alert: true })
      return
    }
    setPrefs((previous) =>
      previous.sortScope === 'collection'
        ? {
            ...DEFAULT_PREFS,
            ...previous,
            collectionSorts: {
              ...previous.collectionSorts,
              [sortKey]: { sort: next, order: direction },
            },
          }
        : { ...DEFAULT_PREFS, ...previous, sort: next, order: direction },
    )
  }
  const refresh = () => {
    void browse.refetch()
    if (single) void detail.refetch()
  }
  return (
    <div
      ref={browserRoot}
      className="catalog-bundle-browser"
      onKeyDown={(event) => {
        const target = event.target as HTMLElement
        if (
          !event.currentTarget.contains(target) ||
          event.defaultPrevented ||
          document.querySelector('[aria-modal="true"], [role="menu"]') ||
          target.closest('input, textarea, select, [contenteditable="true"]')
        )
          return
        const listing = target.closest('[role="listbox"], .collhead')
        if (
          !listing ||
          (target.closest('button, a') && !target.closest('[data-collection-id], [data-bundle-id]'))
        )
          return
        if (
          selectionEnabled &&
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === 'a'
        ) {
          event.preventDefault()
          many(items.map((item) => item.id))
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          many([])
          clearFolders()
          return
        }
        const folderWalk = foldersFolded ? [] : folders.map((item) => `collection:${item.id}`)
        const bundleWalk =
          folders.length > 0 && contentsFolded ? [] : items.map((item) => `bundle:${item.id}`)
        const walk = [...folderWalk, ...bundleWalk]
        const folderActive =
          !foldersFolded && pickedFolders.scope === scope && folderIds.size > 0
            ? pickedFolders.active
            : null
        const from = folderActive
          ? `collection:${folderActive}`
          : active
            ? `bundle:${active}`
            : null
        let next: string | null = null
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          const direction = event.key === 'ArrowDown' ? 'down' : 'up'
          const ids = new Set(walk)
          next = rowStep(
            navTargetsFrom(
              event.currentTarget,
              '[data-collection-id], [data-bundle-id]',
              (element) => {
                const key = element.dataset.collectionId
                  ? `collection:${element.dataset.collectionId}`
                  : `bundle:${element.dataset.bundleId}`
                return ids.has(key) ? key : undefined
              },
            ),
            from,
            direction,
          )
          if (!next && !folderActive) {
            const bundle = navigation.current?.step(active, direction)
            if (bundle) next = `bundle:${bundle}`
          }
        }
        if (!next && ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft'].includes(event.key)) {
          const index = walk.indexOf(from ?? '')
          const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1
          next = walk[Math.max(0, Math.min(walk.length - 1, index < 0 ? 0 : index + delta))] ?? null
        }
        if (event.key === 'Home')
          next = (listing.classList.contains('collhead') ? folderWalk : bundleWalk)[0] ?? null
        if (event.key === 'End')
          next = (listing.classList.contains('collhead') ? folderWalk : bundleWalk).at(-1) ?? null
        if (event.key === 'Enter' && folderIds.size === 1 && folderActive) {
          event.preventDefault()
          onOpenCollection(folderActive)
        } else if (event.key === 'Enter' && single) {
          event.preventDefault()
          onOpen(single)
        }
        if (next) {
          event.preventDefault()
          if (next.startsWith('collection:')) {
            const id = next.slice('collection:'.length)
            selectFolder(id, event)
            const card = browserRoot.current?.querySelector<HTMLElement>(
              `[data-collection-id="${id}"]`,
            )
            card?.focus()
            card?.scrollIntoView({ block: 'nearest' })
          } else {
            const id = next.slice('bundle:'.length)
            select(id, event)
            navigation.current?.focus(id)
          }
        }
      }}
    >
      <div className="center">
        <Toolbar
          leading={headerLeading}
          trailing={headerTrailing}
          title={
            selection.collectionId
              ? (collections.items.find((item) => item.id === selection.collectionId)?.name ??
                'Collection')
              : selection.smartCollectionId
                ? smart.data?.fields.name?.value
                  ? JSON.parse(smart.data.fields.name.value)
                  : 'Smart Collection'
                : (SYSTEM_VIEWS.find((item) => item.view === selection.view)?.label ?? 'All')
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
          allowedSorts={allowedSorts}
          perCollectionSort={prefs.sortScope === 'collection'}
          onPerCollectionSort={(value) =>
            setPrefs((previous) => ({
              ...DEFAULT_PREFS,
              ...previous,
              sortScope: value ? 'collection' : 'global',
            }))
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
        {smart.error && <p role="alert">Saved conditions are unavailable.</p>}
        <div hidden={Boolean(albumId)} className="catalog-album-browser-return">
          {folders.length > 0 && (
            <CollectionHeader
              subcollections={folders}
              layout={prefs.layout}
              sectionLabel={selection.collectionId ? 'Subcollections' : 'Collections'}
              counts={Object.fromEntries(
                folders.map((item) => [
                  item.id,
                  showSubContents ? item.count : (item.direct_count ?? item.count),
                ]),
              )}
              subcounts={subcounts}
              showContents={selection.collectionId ? showSubContents : undefined}
              onToggleShowContents={selection.collectionId ? onShowSubContents : undefined}
              onSelectSubcollection={selectFolder}
              onMarqueeSelect={(ids) => pickFolders(new Set(ids), ids.at(-1) ?? null)}
              onOpenSubcollection={onOpenCollection}
              onContextMenuSubcollection={folderMenu}
              onSectionContextMenu={(event) => {
                const parent = selection.collectionId ?? null
                menu.open(event, [
                  {
                    label: parent ? 'New Subcollection' : 'New Collection',
                    disabled: blocked || !onNewCollection,
                    onClick: () => onNewCollection?.(parent),
                  },
                  null,
                  {
                    label: 'Clean Up Order…',
                    disabled: blocked || includeDescendants,
                    onClick: collections.requestCleanup,
                  },
                ])
              }}
              // A flattened view spans several parents, so it has no one order
              onReorderCollections={
                blocked || includeDescendants
                  ? undefined
                  : (moved, before) =>
                      collections.arrange(moved, selection.collectionId ?? null, before)
              }
              onReparentCollections={(moved, target) =>
                !blocked && collections.arrange(moved, target, null)
              }
              onMoveBundlesInto={(target, copy) =>
                bundleMovesEnabled && collections.moveBundlesInto(target, copy)
              }
              dragItem={dragItem}
              onDragItem={onDragItem}
              selectedIds={folderIds as Set<string>}
              zoom={prefs.zoom}
              subcollapsed={foldersFolded}
              onToggleSubcollapsed={() => setFoldersFolded((value) => !value)}
              contentsCount={browse.data?.pages[0]?.total ?? 0}
              contentsCollapsed={contentsFolded}
              onToggleContents={() => setContentsFolded((value) => !value)}
            />
          )}
          {!(folders.length > 0 && contentsFolded) && (
            <Browser
              navigationRef={navigation}
              unavailableSize={!localHistoryEnabled}
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
              onOpen={onOpen}
              contextMenuOpen={menu.state !== null}
              onContextMenu={bundleMenu}
              onEmptyContextMenu={emptyMenu}
              onReorder={reorder}
              onBundleDragStart={onBundleDrag}
              onBundleDragEnd={onBundleDrag && (() => onBundleDrag(null))}
              isLoading={browse.isPending}
              isError={browse.isError}
              error={browse.error}
              hasNextPage={browse.hasNextPage}
              isFetchingNextPage={browse.isFetchingNextPage}
              fetchNextPage={() => void browse.fetchNextPage()}
              searchQuery={query}
              onRetry={() => void browse.refetch()}
              emptyState={
                anyAdHocActive(filters) ? (
                  <>
                    <div>No bundles here match the filters.</div>
                    <button className="btn" onClick={() => onFilters(emptyAdHocFilters())}>
                      Clear Filters
                    </button>
                  </>
                ) : selection.collectionId && folders.length > 0 && !showSubContents ? (
                  <>
                    <div>No bundles directly in this collection.</div>
                    <div>Open a subcollection above, or tick “Show subcollection contents”.</div>
                  </>
                ) : selection.collectionId ? (
                  <>
                    <div>This collection is empty.</div>
                    <div>Add bundles to it from the grid or file view.</div>
                  </>
                ) : undefined
              }
            />
          )}
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
      {!albumId && inspectedFolder ? (
        <CatalogCollectionInspector
          key={inspectedFolder.id}
          library={library}
          collection={inspectedFolder}
          subcollections={subcounts[inspectedFolder.id] ?? 0}
          collections={collections}
          editable={!blocked}
        />
      ) : !albumId && folderIds.size > 1 ? (
        <aside className="inspector">
          <div className="state">{folderIds.size} collections selected</div>
        </aside>
      ) : !albumId && selectionEnabled && (bulkRetained || selectedIds.size > 1) ? (
        <CatalogMultiBundleInspector
          key={`${library}/${editor}`}
          library={library}
          editor={editor}
          ids={[...selectedIds].sort()}
          fileCount={
            selectedIds.size > 0 && selectedCards.length === selectedIds.size
              ? selectedCards.reduce((total, item) => total + item.file_count, 0)
              : null
          }
          totalSize={
            localHistoryEnabled &&
            selectedIds.size > 0 &&
            selectedCards.length === selectedIds.size &&
            selectedCards.every((item) => item.size_known)
              ? selectedCards.reduce((total, item) => total + item.total_size, 0)
              : null
          }
          blocked={blocked}
          memberships={(status?.selection_version ?? 0) >= 3}
          onReview={onReview}
          onRetainedChange={setBulkRetained}
          onFilterTag={onFilterTag}
          onClose={() => {
            setBulkRetained(false)
            many([])
          }}
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
          summary={items.find((item) => item.id === detail.data.id)}
          onOpenCollection={onOpenCollection}
          onFilterTag={onFilterTag}
          onLocateFile={onLocateFile}
          onOpenDirectory={onOpenDirectory}
          onOpen={() => onOpen(detail.data.id)}
          onAddFiles={
            bundling && detail.data.fields.grouping_state?.value === '"CONFIRMED"'
              ? () =>
                  setAddingFiles({
                    id: detail.data.id,
                    title: JSON.parse(detail.data.fields.title?.value ?? 'null') as string | null,
                  })
              : undefined
          }
          onOpenFile={(file) => onOpenFile(detail.data.id, file)}
          moments={
            <CatalogBundleMoments
              library={library}
              bundle={detail.data.id}
              onPlay={(file, time) => onOpenFile(detail.data.id, file, time)}
            />
          }
        />
      ) : !single && openFolder ? (
        <CatalogCollectionInspector
          key={openFolder.id}
          library={library}
          collection={openFolder}
          subcollections={subcounts[openFolder.id] ?? 0}
          collections={collections}
          editable={!blocked}
        />
      ) : (
        <aside className="inspector">
          <div className="state">
            {detail.error
              ? 'Bundle details are unavailable.'
              : single
                ? 'Loading bundle details…'
                : 'Select a bundle to see its details.'}
          </div>
          {detail.error && (
            <button className="btn" onClick={() => void detail.refetch()}>
              Try Again
            </button>
          )}
        </aside>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
      {cleaning && (
        <CleanupOrderDialog
          title="Clean up bundle order"
          description={
            selection.collectionId
              ? 'Overwrite this collection’s manual order with a chosen sort.'
              : 'Overwrite the global manual order with a chosen sort.'
          }
          choices={[
            { key: 'title:asc', label: 'Title (A–Z)' },
            { key: 'title:desc', label: 'Title (Z–A)' },
            { key: 'date_added:desc', label: 'Date Added (newest first)' },
            { key: 'date_added:asc', label: 'Date Added (oldest first)' },
            { key: 'rating:desc', label: 'Rating (high → low)' },
            { key: 'rating:asc', label: 'Rating (low → high)' },
            { key: 'file_count:desc', label: 'File Count (most first)' },
            { key: 'file_count:asc', label: 'File Count (fewest first)' },
          ]}
          pending={false}
          onCancel={() => setCleaning(false)}
          onConfirm={(choice) => {
            const [key, direction] = choice.split(':') as [
              'title' | 'rating' | 'date_added' | 'file_count',
              'asc' | 'desc',
            ]
            setCleaning(false)
            organize(
              () =>
                cleanUpBundleOrder(
                  library,
                  selection.collectionId ?? null,
                  key,
                  direction === 'desc',
                ),
              'Bundle order cleaned up.',
            )
          }}
        />
      )}
      {creatingBundle && (
        <CreateEmptyBundleDialog
          onClose={() => setCreatingBundle(false)}
          onCreated={(id) => {
            setCreatingBundle(false)
            setAddingFiles({ id, title: null })
          }}
        />
      )}
      {addingFiles && (
        <AddFilesToBundleDialog
          bundleId={addingFiles.id}
          title={addingFiles.title}
          onClose={() => setAddingFiles(null)}
          onApplied={(message) => {
            setAddingFiles(null)
            onNotice({ text: message })
          }}
        />
      )}
      {deleting && (
        <DeleteBundlesDialog
          count={deleting.length}
          pending={false}
          filesReturnToUnbundled
          writeMode={false}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const targets = deleting
            setDeleting(null)
            setPicked({ scope, ids: new Set(), active: null, anchor: null })
            organize(
              () => deleteBundles(library, targets),
              targets.length === 1 ? 'Bundle deleted.' : `${targets.length} bundles deleted.`,
            )
          }}
        />
      )}
    </div>
  )
}
