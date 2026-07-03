import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  BundleSort,
  CollectionRead,
  FileSelection,
  FileViewEntry,
  JobRead,
  LibraryRead,
  SmartCollectionRead,
  SortOrder,
} from './api/client'
import { setActiveLibraryId } from './api/client'
import {
  useBatchUpdate,
  useBrowse,
  useCollectionCounts,
  useCollections,
  useCleanupBundleOrder,
  useCleanupCollectionOrder,
  useCreateCollection,
  useDeleteBundles,
  useDeleteCollection,
  useReorderBundles,
  useReorderCollections,
  useLibraries,
  useLibraryAuth,
  useLibraryLock,
  useProbe,
  useRenameCollection,
  useUpdateCollection,
  useScan,
  useSmartCollectionMutations,
  useSmartCollections,
  useUpdateLibrary,
  useViewCounts,
} from './api/hooks'
import { AllTagsPage } from './app/AllTagsPage'
import { ContextMenu } from './app/ContextMenu'
import { type MenuEntry, useContextMenu } from './app/useContextMenu'
import { Browser } from './app/Browser'
import { BundleAlbum } from './app/BundleAlbum'
import { DeleteBundlesDialog } from './app/DeleteBundlesDialog'
import { FileInspector } from './app/FileInspector'
import { FileView } from './app/FileView'
import { GroupingReview } from './app/GroupingReview'
import { LibraryManager } from './app/LibraryManager'
import { LockScreen } from './app/LockScreen'
import { type FilterDraft, emptyDraft } from './app/filterModel'
import {
  type AdHocFilters,
  type FacetContext,
  adHocFiltersToExpression,
  combineFilters,
  emptyAdHocFilters,
} from './app/adHocFilters'
import { Inspector } from './app/Inspector'
import {
  AddFilesToBundleDialog,
  AddToBundleDialog,
  CreateBundleDialog,
  CreateEmptyBundleDialog,
} from './app/ManualBundlingDialogs'
import { CleanupOrderDialog } from './app/CleanupOrderDialog'
import type { DragItem } from './app/dnd'
import { CollectionHeader } from './app/CollectionHeader'
import { CollectionInspector } from './app/CollectionInspector'
import { MultiBundleInspector } from './app/MultiBundleInspector'
import { RemoveCollectionDialog } from './app/RemoveCollectionDialog'
import { Sidebar } from './app/Sidebar'
import { SmartCollectionEditor } from './app/SmartCollectionEditor'
import { Toolbar } from './app/Toolbar'
import {
  DEFAULT_PREFS,
  SYSTEM_VIEWS,
  type AppMode,
  type BrowsePrefs,
  type Selection,
  type SortPref,
} from './app/types'
import { usePersistentState } from './state/usePersistentState'

interface EditorState {
  existing?: SmartCollectionRead | null
  initialDraft?: FilterDraft
}

/** `rootId` plus every collection nested beneath it (used to clear a stale
 * selection when a cascade removal deletes the collection currently in view). */
function collectionSubtreeIds(collections: CollectionRead[], rootId: string): Set<string> {
  const childrenOf = new Map<string, string[]>()
  for (const c of collections)
    if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c.id])
  const ids = new Set<string>([rootId])
  const stack = [rootId]
  while (stack.length) {
    const id = stack.pop() as string
    for (const childId of childrenOf.get(id) ?? []) {
      ids.add(childId)
      stack.push(childId)
    }
  }
  return ids
}

function Resizer({
  side,
  width,
  setWidth,
  min,
  max,
}: {
  side: 'left' | 'right'
  width: number
  setWidth: (n: number) => void
  min: number
  max: number
}) {
  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = width
    const onMove = (ev: MouseEvent) => {
      const delta = side === 'left' ? ev.clientX - startX : startX - ev.clientX
      setWidth(Math.max(min, Math.min(max, startW + delta)))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    document.body.style.cursor = 'col-resize'
  }
  return (
    <div
      className="resizer-bar"
      style={{ position: 'absolute', top: 0, bottom: 0, width: 7, [side]: width - 3 }}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}

/**
 * App shell: resolve the active library (one per tab, ADR-0008) before any
 * content query runs. While there are no libraries the manager is shown so the
 * owner can create or register one. The workspace is keyed by library id, so
 * switching libraries remounts it with fresh query state — no cross-library
 * cache bleed.
 */
export default function App() {
  const librariesQuery = useLibraries()
  const [chosenId, setChosenId] = usePersistentState<string | null>('cairndex.libraryId', null)
  const [managing, setManaging] = useState(false)

  const libraries = useMemo(() => librariesQuery.data ?? [], [librariesQuery.data])
  const libraryId = useMemo(() => {
    if (chosenId && libraries.some((l) => l.id === chosenId)) return chosenId
    return libraries[0]?.id ?? null
  }, [libraries, chosenId])

  // Set the module-global active library during render so content queries (which
  // run after commit) target the right library.
  if (libraryId) setActiveLibraryId(libraryId)

  // Per-library lock (ADR-0010): resolve lock state before mounting the
  // workspace, so a protected+locked library shows its passphrase screen and
  // never fires content queries while locked.
  const auth = useLibraryAuth(libraryId)
  const lock = useLibraryLock(libraryId)
  const locked = auth.data?.protected === true && auth.data.unlocked === false

  if (librariesQuery.isLoading) {
    return <div className="app-loading">Loading…</div>
  }

  if (!libraryId) {
    // No library yet: show the empty app shell (not a forced dialog) so the
    // owner can add one from the sidebar "+" when ready. Creating/registering
    // re-renders into the workspace once the list refreshes.
    return (
      <>
        <NoLibraryView onManage={() => setManaging(true)} />
        {managing && <LibraryManager onClose={() => setManaging(false)} />}
      </>
    )
  }

  if (locked) {
    return (
      <LockScreen
        key={libraryId}
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={setChosenId}
        onUnlock={(passphrase) => lock.unlock.mutate(passphrase)}
        unlocking={lock.unlock.isPending}
        error={lock.unlock.error?.message ?? null}
      />
    )
  }

  return (
    <>
      <Workspace
        key={libraryId}
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={setChosenId}
        onManage={() => setManaging(true)}
        canLock={auth.data?.protected === true}
        onLock={() => lock.lock.mutate()}
      />
      {managing && <LibraryManager onClose={() => setManaging(false)} />}
    </>
  )
}

/**
 * Empty app shell shown before any library exists. Renders the real sidebar
 * (so the "+" to add a library sits where it always does) with no content, and
 * an empty center pane — no content queries run without an active library.
 */
function NoLibraryView({ onManage }: { onManage: () => void }) {
  const noop = () => {}
  return (
    <div className="app">
      <Sidebar
        mode="collection"
        onMode={noop}
        libraries={[]}
        libraryId={null}
        onChangeLibrary={noop}
        onManageLibraries={onManage}
        onUpdateLibrary={noop}
        onScanFiles={noop}
        onProbe={noop}
        onReviewGrouping={noop}
        selection={{ view: 'all', collectionId: null }}
        onSelect={noop}
        collections={[]}
        onDeleteCollection={noop}
        onCreateCollection={noop}
        onRenameCollection={noop}
        onReorderCollections={noop}
        smartCollections={[]}
        onNewSmartCollection={noop}
        onEditSmartCollection={noop}
        onDeleteSmartCollection={noop}
      />
      <div className="center">
        <div className="state">
          No library yet. Click <strong>+</strong> in the sidebar to add one.
        </div>
      </div>
      <aside className="inspector" />
    </div>
  )
}

interface WorkspaceProps {
  libraries: LibraryRead[]
  libraryId: string
  onChangeLibrary: (id: string) => void
  onManage: () => void
  canLock: boolean
  onLock: () => void
}

function Workspace({
  libraries,
  libraryId,
  onChangeLibrary,
  onManage,
  canLock,
  onLock,
}: WorkspaceProps) {
  const [storedPrefs, setPrefs] = usePersistentState<BrowsePrefs>('cairndex.prefs', DEFAULT_PREFS)
  // Merge in defaults so prefs persisted before newer fields existed
  // (sortScope/collectionSorts) don't read back as undefined.
  const prefs = useMemo(() => ({ ...DEFAULT_PREFS, ...storedPrefs }), [storedPrefs])
  const [sidebarW, setSidebarW] = usePersistentState('cairndex.sidebarW', 240)
  const [inspectorW, setInspectorW] = usePersistentState('cairndex.inspectorW', 300)

  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  // Ad-hoc toolbar filters (Eagle-style). Local UI state only — not persisted to
  // localStorage or the URL in this milestone. Composes with the active Smart
  // Collection and the current view/collection/search.
  const [adHocFilters, setAdHocFilters] = useState<AdHocFilters>(emptyAdHocFilters)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  // Anchors for Shift-range selection: the last plainly-clicked bundle / folder
  // card. Shift+click selects the inclusive range from the anchor to the click.
  const [bundleAnchor, setBundleAnchor] = useState<string | null>(null)
  const [collectionAnchor, setCollectionAnchor] = useState<string | null>(null)
  // What's currently being dragged (bundles or a collection), so folder cards and
  // sidebar rows can accept cross-surface drops (reparent / move into collection).
  const [dragItem, setDragItem] = useState<DragItem | null>(null)
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [reviewingGrouping, setReviewingGrouping] = useState(false)
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null)
  const [removingCollections, setRemovingCollections] = useState<CollectionRead[] | null>(null)
  const [deletingBundles, setDeletingBundles] = useState<string[] | null>(null)
  // "Clean up by…" dialogs (rewrite the manual order). Collections offer Title
  // A–Z/Z–A; bundles reuse the toolbar sorts.
  const [cleaningCollections, setCleaningCollections] = useState(false)
  const [cleaningBundles, setCleaningBundles] = useState(false)

  // Manual bundling assistant dialogs. Each holds the selection to act on —
  // File-View/Unbundled files as relative paths (unlinked ones auto-linked at
  // apply) or backend file ids.
  const [addingToBundle, setAddingToBundle] = useState<FileSelection | null>(null)
  const [creatingBundle, setCreatingBundle] = useState<FileSelection | null>(null)
  const [creatingEmpty, setCreatingEmpty] = useState(false)
  const [addFilesBundleId, setAddFilesBundleId] = useState<string | null>(null)
  // Transient success banner after a manual bundling action.
  const [flash, setFlash] = useState<string | null>(null)
  useEffect(() => {
    if (flash === null) return
    const t = setTimeout(() => setFlash(null), 4000)
    return () => clearTimeout(t)
  }, [flash])

  const [mode, setMode] = useState<AppMode>('collection')
  // The Files surface has two scopes: browse the directory tree, or the flat
  // "Unbundled" to-bundle queue (a cross-library list of not-yet-bundled files).
  const [fileScope, setFileScope] = useState<'browse' | 'unbundled'>('browse')
  const [filePath, setFilePath] = useState('')
  const [fileEntry, setFileEntry] = useState<FileViewEntry | null>(null)
  // A file to highlight after "Locate in File Browser" (until the user navigates
  // or picks another entry), independent of the loaded fileEntry object.
  const [locatedPath, setLocatedPath] = useState<string | null>(null)
  // Live snapshot of the running maintenance job (scan/probe/thumbnail) so the
  // sidebar can render a determinate/indeterminate progress bar. Null when idle.
  const [activeJob, setActiveJob] = useState<JobRead | null>(null)

  const collections = useCollections()
  const smartCollections = useSmartCollections()
  const counts = useViewCounts()
  const collectionCounts = useCollectionCounts()
  const updateLibrary = useUpdateLibrary({
    onProgress: setActiveJob,
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const scanFiles = useScan({
    onProgress: setActiveJob,
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const probe = useProbe({ onProgress: setActiveJob })
  const deleteBundles = useDeleteBundles()
  const deleteCollection = useDeleteCollection()
  const createCollection = useCreateCollection()
  const renameCollection = useRenameCollection()
  const updateCollection = useUpdateCollection()
  const reorderCollections = useReorderCollections()
  const cleanupCollectionOrder = useCleanupCollectionOrder()
  const reorderBundles = useReorderBundles()
  const cleanupBundleOrder = useCleanupBundleOrder()
  const smartCollectionMutations = useSmartCollectionMutations()
  const batch = useBatchUpdate()
  const menu = useContextMenu()

  const libraryName = libraries.find((l) => l.id === libraryId)?.name ?? 'Library'

  const activeSmartCollection =
    smartCollections.data?.find((sc) => sc.id === selection.smartCollectionId) ?? null

  // Debounce the toolbar search so each keystroke doesn't hit the backend; the
  // debounced value drives a whole-library FTS query (not a loaded-window filter).
  const [debouncedSearch, setDebouncedSearch] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search), 250)
    return () => clearTimeout(t)
  }, [search])

  // When viewing a collection, its direct subcollections are shown as folder
  // tiles above the grid; the toggle (persisted) decides whether the grid also
  // includes bundles from those subcollections. Off by default: a collection
  // shows only its own bundles, like a folder shows only its own files.
  const [showSubContents, setShowSubContents] = usePersistentState(
    'cairndex.showSubcollectionContents',
    false,
  )
  const [subcollapsed, setSubcollapsed] = useState(false)
  const [contentsCollapsed, setContentsCollapsed] = useState(false)
  // Subcollections selected (click or marquee) for their inspector, distinct
  // from navigating into one (double-click). A Set so drag-select can pick
  // several. Mutually exclusive with the bundle selection — selecting either
  // clears the other, since acting on both at once is meaningless.
  const [selectedCollectionIds, setSelectedCollectionIds] = useState<Set<string>>(new Set())
  // Each collection opens with both sections expanded (don't carry a fold from
  // the previously-viewed collection). Reset during render on change rather than
  // in an effect — React's "adjust state when a prop changes" pattern.
  const [foldedFor, setFoldedFor] = useState(selection.collectionId)
  if (foldedFor !== selection.collectionId) {
    setFoldedFor(selection.collectionId)
    setSubcollapsed(false)
    setContentsCollapsed(false)
    setSelectedCollectionIds(new Set())
  }
  // The folder cards shown above the grid: a collection's direct subcollections
  // when viewing one, or every root (top-level) collection in the All view. When
  // "Show subcollection contents" is on inside a collection, the section flattens
  // to *every* descendant collection (depth-first, manual order) so the folders
  // match the grid, which then shows the whole subtree's bundles.
  const isAllView =
    selection.view === 'all' && !selection.collectionId && !selection.smartCollectionId
  // The section flattens to every descendant collection (depth-first, manual
  // order) when "Show subcollection contents" is on — both inside a collection
  // and in the All view (where it walks from every root).
  const headerFlattened = showSubContents && (selection.collectionId !== null || isAllView)
  const headerCollections = useMemo(() => {
    const all = collections.data ?? []
    const parentId = selection.collectionId ?? null
    if (parentId === null && !isAllView) return []
    // Manual order (shared with the sidebar), name as the stable tie-break.
    const bySortOrder = (a: CollectionRead, b: CollectionRead) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name)
    if (headerFlattened) {
      const childrenOf = new Map<string, CollectionRead[]>()
      for (const c of all)
        if (c.parent_id) childrenOf.set(c.parent_id, [...(childrenOf.get(c.parent_id) ?? []), c])
      const flat: CollectionRead[] = []
      const walk = (pid: string) => {
        for (const child of (childrenOf.get(pid) ?? []).sort(bySortOrder)) {
          flat.push(child)
          walk(child.id)
        }
      }
      if (selection.collectionId) {
        walk(selection.collectionId)
      } else {
        // All view: start from every root, then their subtrees.
        for (const root of all.filter((c) => (c.parent_id ?? null) === null).sort(bySortOrder)) {
          flat.push(root)
          walk(root.id)
        }
      }
      return flat
    }
    return all.filter((c) => (c.parent_id ?? null) === parentId).sort(bySortOrder)
  }, [collections.data, selection.collectionId, isAllView, headerFlattened])

  // Direct subcollection count per collection id (for the card footers).
  const subCounts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const c of collections.data ?? [])
      if (c.parent_id) map[c.parent_id] = (map[c.parent_id] ?? 0) + 1
    return map
  }, [collections.data])

  // Smart Collection filter AND the ad-hoc toolbar filter stack into one AST
  // (both compile to the same canonical shape). Null filters are ignored.
  const smartFilter = activeSmartCollection?.filter ?? null
  const combinedFilter = useMemo(
    () => combineFilters(smartFilter, adHocFiltersToExpression(adHocFilters)),
    [smartFilter, adHocFilters],
  )

  const includeSubContents = selection.collectionId !== null && showSubContents
  // Manual order scope: a single collection uses its own membership order; the
  // All/system views and a descendant-inclusive collection use the global order
  // (mirrors browse's MANUAL sort). Drives drag-reorder and "Clean up by…".
  const manualScopeCollectionId =
    selection.collectionId && !includeSubContents ? selection.collectionId : null

  // #8: the sort can be one global setting or remembered per collection/view.
  // This key buckets a smart collection / a collection / a system view (incl.
  // All) separately so each can keep its own last-used sort.
  const sortKey = selection.smartCollectionId
    ? `smart:${selection.smartCollectionId}`
    : selection.collectionId
      ? `coll:${selection.collectionId}`
      : `view:${selection.view}`
  const effectiveSort: SortPref =
    prefs.sortScope === 'collection'
      ? (prefs.collectionSorts[sortKey] ?? { sort: prefs.sort, order: prefs.order })
      : { sort: prefs.sort, order: prefs.order }
  const setEffectiveSort = useCallback(
    (sort: BundleSort, order: SortOrder) => {
      if (prefs.sortScope === 'collection') {
        setPrefs({
          ...prefs,
          collectionSorts: { ...prefs.collectionSorts, [sortKey]: { sort, order } },
        })
      } else {
        setPrefs({ ...prefs, sort, order })
      }
    },
    [prefs, setPrefs, sortKey],
  )

  // In the All tab the grid is scoped like a file-browser root: with the toggle
  // OFF it shows only *uncategorized* bundles (top-level "loose" items) alongside
  // the root collection folders; with the toggle ON it flattens to every bundle.
  const browseView = isAllView && !showSubContents ? 'uncategorized' : selection.view
  const browse = useBrowse({
    view: browseView,
    collectionId: selection.collectionId,
    includeDescendants: includeSubContents,
    sort: effectiveSort.sort,
    order: effectiveSort.order,
    limit: 100,
    filter: combinedFilter,
    search: debouncedSearch.trim() || null,
  })

  // Context the toolbar's facet-count popovers need (each strips its own category).
  const facetContext: FacetContext = {
    view: browseView,
    collectionId: selection.collectionId,
    includeDescendants: includeSubContents,
    q: debouncedSearch.trim() || null,
    smartFilter,
  }

  // Backend search returns the matching page directly — no client-side filtering.
  const items = useMemo(() => browse.data?.pages.flatMap((p) => p.items) ?? [], [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const filtered = items

  // Exactly one subcollection selected → show its inspector; several → a small
  // multi-selection summary (see the right panel below).
  const singleSelectedCollectionId =
    selectedCollectionIds.size === 1 ? [...selectedCollectionIds][0] : null
  const selectedCollection = singleSelectedCollectionId
    ? (collections.data?.find((c) => c.id === singleSelectedCollectionId) ?? null)
    : null

  const title = useMemo(() => {
    if (activeSmartCollection) return activeSmartCollection.name
    if (selection.collectionId) {
      return collections.data?.find((c) => c.id === selection.collectionId)?.name ?? 'Collection'
    }
    return SYSTEM_VIEWS.find((v) => v.view === selection.view)?.label ?? 'All'
  }, [selection, collections.data, activeSmartCollection])

  const select = useCallback(
    (id: string, e: React.MouseEvent) => {
      // Shift+click: select the inclusive range from the anchor to this card,
      // over the current render order.
      if (e.shiftKey && bundleAnchor) {
        const ids = filtered.map((i) => i.id)
        const a = ids.indexOf(bundleAnchor)
        const b = ids.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedIds(new Set(ids.slice(lo, hi + 1)))
          setActiveId(id)
          setSelectedCollectionIds(new Set())
          return
        }
      }
      if (e.metaKey || e.ctrlKey) {
        setSelectedIds((prev) => {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        })
      } else {
        setSelectedIds(new Set([id]))
      }
      // A plain/toggle click (re)sets the range anchor.
      setBundleAnchor(id)
      setActiveId(id)
      setSelectedCollectionIds(new Set())
    },
    [filtered, bundleAnchor],
  )

  // Marquee (drag-to-select) result from Browser — the full resulting
  // selection, already merged with the pre-drag selection when additive.
  // Always clears the subcollection selection (an empty result is an
  // empty-space click that deselects everything).
  const selectMany = useCallback((ids: string[]) => {
    setSelectedIds(new Set(ids))
    setActiveId(ids.length ? (ids[ids.length - 1] ?? null) : null)
    setSelectedCollectionIds(new Set())
  }, [])

  const open = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
    setActiveId(id)
    setSelectedCollectionIds(new Set())
    setOpenBundleId(id)
  }, [])

  // Click a subcollection card (with modifier = toggle, Shift = range). Clears
  // the bundle selection to keep the two mutually exclusive.
  const selectCollection = useCallback(
    (id: string, e: React.MouseEvent) => {
      if (e.shiftKey && collectionAnchor) {
        const ids = headerCollections.map((c) => c.id)
        const a = ids.indexOf(collectionAnchor)
        const b = ids.indexOf(id)
        if (a !== -1 && b !== -1) {
          const [lo, hi] = a < b ? [a, b] : [b, a]
          setSelectedCollectionIds(new Set(ids.slice(lo, hi + 1)))
          setSelectedIds(new Set())
          setActiveId(null)
          return
        }
      }
      setSelectedCollectionIds((prev) => {
        if (e.metaKey || e.ctrlKey) {
          const next = new Set(prev)
          if (next.has(id)) next.delete(id)
          else next.add(id)
          return next
        }
        return new Set([id])
      })
      setCollectionAnchor(id)
      setSelectedIds(new Set())
      setActiveId(null)
    },
    [headerCollections, collectionAnchor],
  )

  // Marquee result over the subcollection cards — replaces the subcollection
  // selection wholesale and clears the bundle selection.
  const selectCollectionsMany = useCallback((ids: string[]) => {
    setSelectedCollectionIds(new Set(ids))
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  // Double-clicking a tag on the All Tags page: go to All bundles, clear the
  // text search, and apply a global Equal/direct tag filter (direct membership
  // only — no descendant expansion), whether the tag is a parent or a leaf.
  const applyTagFilterGlobally = useCallback((tagId: string) => {
    setMode('collection')
    setSelection({ view: 'all', collectionId: null })
    setSearch('')
    setAdHocFilters({
      tags: { rule: 'equal', includeDescendants: false, include: [tagId], exclude: [] },
      rating: null,
    })
    setSelectedIds(new Set())
    setActiveId(null)
    setSelectedCollectionIds(new Set())
    setOpenBundleId(null)
  }, [])

  // Right-click on a bundle card/row (Bundles surface). Operate on the whole
  // selection when the clicked card is part of a multi-selection; otherwise
  // target (and select) just this one. Deletion is confirmed in a dialog.
  const bundleContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      const targets = selectedIds.has(id) && selectedIds.size > 1 ? [...selectedIds] : [id]
      const n = targets.length
      if (n === 1) {
        setSelectedIds(new Set([id]))
        setActiveId(id)
      }
      const items: MenuEntry[] = [{ label: 'Open', onClick: () => open(id), disabled: n > 1 }]
      if (selection.collectionId) {
        const collectionId = selection.collectionId
        items.push({
          label: 'Set as Collection Cover',
          disabled: n > 1,
          onClick: () =>
            updateCollection.mutate({ id: collectionId, patch: { cover_bundle_id: id } }),
        })
        items.push({
          label: n > 1 ? `Remove ${n} from This Collection` : 'Remove from This Collection',
          onClick: () =>
            batch.mutate({ bundle_ids: targets, remove_collection_ids: [collectionId] }),
        })
      }
      items.push(null, {
        label: n > 1 ? `Delete ${n} Bundles` : 'Delete Bundle',
        danger: true,
        onClick: () => setDeletingBundles(targets),
      })
      menu.open(e, items)
    },
    [selectedIds, selection.collectionId, open, batch, menu, updateCollection],
  )

  // Files-surface context actions (Unbundled list or the directory tree) operate
  // on relative paths; unlinked paths are auto-linked server-side at apply.
  const bundleFilePaths = useCallback(
    (paths: string[]) => setAddingToBundle({ relativePaths: paths }),
    [],
  )
  const createBundleFromPaths = useCallback(
    (paths: string[]) => setCreatingBundle({ relativePaths: paths }),
    [],
  )

  // Right-click empty browser space → create a bundle, or clean up the bundle
  // manual order for the current scope.
  const emptyContextMenu = useCallback(
    (e: React.MouseEvent) => {
      menu.open(e, [
        { label: 'Create Bundle…', onClick: () => setCreatingEmpty(true) },
        null,
        {
          label: 'Clean Up Order…',
          onClick: () => setCleaningBundles(true),
          // Reordering a flattened list is meaningless — no manual order to tidy.
          disabled: headerFlattened,
        },
      ])
    },
    [menu, headerFlattened],
  )

  const onManualBundlingApplied = useCallback(
    (message: string) => {
      setAddingToBundle(null)
      setCreatingBundle(null)
      setAddFilesBundleId(null)
      clearSelection()
      setFlash(message)
    },
    [clearSelection],
  )

  const confirmDeleteBundles = useCallback(
    (deleteFiles: boolean) => {
      const targets = deletingBundles
      if (!targets) return
      // Filesystem deletion isn't wired yet (metadata-only milestone); the
      // checkbox state is captured for a future write-enabled endpoint.
      void deleteFiles
      deleteBundles.mutate(targets, {
        onSuccess: () => {
          setDeletingBundles(null)
          clearSelection()
          if (openBundleId && targets.includes(openBundleId)) setOpenBundleId(null)
        },
      })
    },
    [deletingBundles, deleteBundles, clearSelection, openBundleId],
  )

  // Removal is confirmed in a dialog (RemoveCollectionDialog) so the owner can
  // choose whether to also remove subcollections; the menu item just opens it.
  const removeCollection = useCallback(
    (collection: CollectionRead) => setRemovingCollections([collection]),
    [],
  )

  // Right-click a folder card in the main browser. Operate on the whole
  // subcollection selection when the clicked card is part of a multi-selection;
  // otherwise target (and select) just this one. Mirrors bundleContextMenu.
  const collectionContextMenu = useCallback(
    (id: string, e: React.MouseEvent) => {
      const targetIds =
        selectedCollectionIds.has(id) && selectedCollectionIds.size > 1
          ? [...selectedCollectionIds]
          : [id]
      if (targetIds.length === 1) {
        setSelectedCollectionIds(new Set([id]))
        setSelectedIds(new Set())
        setActiveId(null)
      }
      const n = targetIds.length
      const targets = (collections.data ?? []).filter((c) => targetIds.includes(c.id))
      menu.open(e, [
        {
          label: n > 1 ? `Delete ${n} Collections` : 'Delete Collection',
          danger: true,
          onClick: () => setRemovingCollections(targets),
        },
      ])
    },
    [selectedCollectionIds, collections.data, menu],
  )

  // Drag a collection onto another → reparent it (cycle/self guarded server-side).
  const reparentCollection = useCallback(
    (id: string, newParentId: string | null) => {
      if (id === newParentId) return
      updateCollection.mutate({ id, patch: { parent_id: newParentId } })
    },
    [updateCollection],
  )

  // Drop a collection onto the gap before/after a row in a *different* parent
  // group (including the top level, newParentId=null): reparent it into that
  // group, then write the new sibling order. Reorder runs after the reparent
  // commits so the backend's same-parent validation passes. This is what makes
  // "move a subcollection out to the top level" work.
  const moveCollection = useCallback(
    (id: string, newParentId: string | null, orderedIds: string[]) => {
      if (id === newParentId) return
      updateCollection.mutate(
        { id, patch: { parent_id: newParentId } },
        { onSuccess: () => reorderCollections.mutate({ parentId: newParentId, orderedIds }) },
      )
    },
    [updateCollection, reorderCollections],
  )

  // Drop the dragged bundles onto a collection → add to it, and (unless Alt =
  // "add") remove them from the collection currently in view. Reads the dragged
  // bundle ids from the active dragItem.
  const moveBundlesToCollection = useCallback(
    (targetCollectionId: string, alt: boolean) => {
      if (dragItem?.kind !== 'bundles' || dragItem.ids.length === 0) return
      batch.mutate({
        bundle_ids: dragItem.ids,
        add_collection_ids: [targetCollectionId],
        remove_collection_ids: alt || !selection.collectionId ? [] : [selection.collectionId],
      })
      clearSelection()
    },
    [batch, dragItem, selection.collectionId, clearSelection],
  )

  // Right-click empty space in the subcollection section → clean up folder order.
  const collectionSectionContextMenu = useCallback(
    (e: React.MouseEvent) => {
      menu.open(e, [
        {
          label: 'Clean Up Order…',
          onClick: () => setCleaningCollections(true),
          disabled: headerFlattened,
        },
      ])
    },
    [menu, headerFlattened],
  )

  const confirmRemoveCollection = useCallback(
    (cascade: boolean) => {
      const targets = removingCollections
      if (!targets || targets.length === 0) return
      // When cascading, drop any target that is itself a descendant of another
      // selected target — its parent's cascade already removes it, so deleting it
      // again would 404.
      const ids = new Set(targets.map((t) => t.id))
      const effective = cascade
        ? targets.filter((t) => {
            let cur = t.parent_id
            while (cur) {
              if (ids.has(cur)) return false
              cur = collections.data?.find((c) => c.id === cur)?.parent_id ?? null
            }
            return true
          })
        : targets
      // Every collection whose view would become stale once these are gone.
      const affected = new Set<string>()
      for (const t of effective)
        for (const id of cascade ? collectionSubtreeIds(collections.data ?? [], t.id) : [t.id])
          affected.add(id)
      Promise.all(effective.map((t) => deleteCollection.mutateAsync({ id: t.id, cascade }))).then(
        () => {
          setRemovingCollections(null)
          setSelectedCollectionIds(new Set())
          if (selection.collectionId && affected.has(selection.collectionId)) {
            setSelection({ view: 'all', collectionId: null })
          }
        },
      )
    },
    [removingCollections, deleteCollection, collections.data, selection.collectionId],
  )

  const removeSmartCollection = useCallback(
    (sc: SmartCollectionRead) => {
      if (
        !window.confirm(`Delete smart collection “${sc.name}”? This removes the saved filter only.`)
      )
        return
      smartCollectionMutations.remove.mutate(sc.id, {
        onSuccess: () => {
          if (selection.smartCollectionId === sc.id) {
            setSelection({ view: 'all', collectionId: null })
          }
        },
      })
    },
    [smartCollectionMutations.remove, selection.smartCollectionId],
  )

  const moveSelection = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      const idx = filtered.findIndex((i) => i.id === activeId)
      const next = Math.max(0, Math.min(filtered.length - 1, idx < 0 ? 0 : idx + delta))
      const target = filtered[next]
      if (target) {
        setSelectedIds(new Set([target.id]))
        setActiveId(target.id)
        document
          .querySelector(`[data-bundle-id="${target.id}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
    },
    [filtered, activeId],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      if (openBundleId !== null) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault()
        moveSelection(1)
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        moveSelection(-1)
      } else if (e.key === 'Escape') {
        clearSelection()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveSelection, clearSelection, openBundleId])

  return (
    <div
      className={`app${mode === 'tags' ? ' app--no-inspector' : ''}`}
      style={
        {
          ['--sidebar-w']: `${sidebarW}px`,
          ['--inspector-w']: `${inspectorW}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar
        mode={mode}
        onMode={(m) => {
          setMode(m)
          if (m === 'file') setFileScope('browse')
        }}
        fileScope={fileScope}
        onOpenUnbundled={() => {
          setMode('file')
          setFileScope('unbundled')
          setFileEntry(null)
        }}
        onOpenAllTags={() => {
          setMode('tags')
          clearSelection()
          setSelectedCollectionIds(new Set())
          setOpenBundleId(null)
        }}
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        onManageLibraries={onManage}
        canLock={canLock}
        onLock={onLock}
        onUpdateLibrary={() => updateLibrary.mutate()}
        updating={updateLibrary.isPending}
        onScanFiles={() => scanFiles.mutate()}
        scanningFiles={scanFiles.isPending}
        onProbe={() => probe.mutate()}
        probing={probe.isPending}
        activeJob={activeJob}
        maintenanceError={
          updateLibrary.error?.message ?? scanFiles.error?.message ?? probe.error?.message ?? null
        }
        onReviewGrouping={() => {
          setReviewPlanId(null)
          setReviewingGrouping(true)
        }}
        selection={selection}
        onSelect={(s) => {
          setMode('collection')
          setSelection(s)
          clearSelection()
          setSelectedCollectionIds(new Set())
          setOpenBundleId(null)
        }}
        counts={counts.data}
        collections={collections.data ?? []}
        collectionCounts={collectionCounts.data}
        onDeleteCollection={removeCollection}
        onCreateCollection={(payload, callbacks) => createCollection.mutate(payload, callbacks)}
        onRenameCollection={(id, name, callbacks) =>
          renameCollection.mutate({ id, name }, callbacks)
        }
        onReorderCollections={(parentId, orderedIds) =>
          reorderCollections.mutate({ parentId, orderedIds })
        }
        onMoveCollection={moveCollection}
        onCleanupCollections={() => setCleaningCollections(true)}
        dragItem={dragItem}
        onDragItem={setDragItem}
        onReparentCollection={reparentCollection}
        onMoveBundlesInto={moveBundlesToCollection}
        smartCollections={smartCollections.data ?? []}
        onNewSmartCollection={() => setEditor({ initialDraft: emptyDraft() })}
        onEditSmartCollection={(sc) => setEditor({ existing: sc })}
        onDeleteSmartCollection={removeSmartCollection}
      />

      <div className="center">
        {mode === 'tags' ? (
          <AllTagsPage onApplyTagFilter={applyTagFilterGlobally} />
        ) : mode === 'file' ? (
          <FileView
            libraryName={libraryName}
            scope={fileScope}
            path={filePath}
            selectedPath={locatedPath ?? fileEntry?.relative_path ?? null}
            onNavigate={(path) => {
              setFilePath(path)
              setFileEntry(null)
              setLocatedPath(null)
              setFileScope('browse')
            }}
            onSelectEntry={(entry) => {
              setFileEntry(entry)
              setLocatedPath(null)
            }}
            onAddToBundle={bundleFilePaths}
            onCreateBundle={createBundleFromPaths}
          />
        ) : (
          <>
            <Toolbar
              title={title}
              total={total}
              search={search}
              onSearch={setSearch}
              prefs={prefs}
              onPrefs={setPrefs}
              sort={effectiveSort.sort}
              order={effectiveSort.order}
              onSort={setEffectiveSort}
              perCollectionSort={prefs.sortScope === 'collection'}
              onPerCollectionSort={(v) =>
                setPrefs({ ...prefs, sortScope: v ? 'collection' : 'global' })
              }
              adHocFilters={adHocFilters}
              onAdHocFilters={setAdHocFilters}
              facetContext={facetContext}
            />
            {openBundleId ? (
              <BundleAlbum
                bundleId={openBundleId}
                onBack={() => setOpenBundleId(null)}
                onLocateFile={(relativePath) => {
                  const dir = relativePath.includes('/')
                    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
                    : ''
                  setMode('file')
                  setFileScope('browse')
                  setFilePath(dir)
                  setFileEntry(null)
                  setLocatedPath(relativePath)
                  setOpenBundleId(null)
                }}
              />
            ) : (
              <>
                {headerCollections.length > 0 && (
                  <CollectionHeader
                    subcollections={headerCollections}
                    sectionLabel={selection.collectionId ? 'Subcollections' : 'Collections'}
                    counts={collectionCounts.data}
                    subcounts={subCounts}
                    showContents={showSubContents}
                    onToggleShowContents={setShowSubContents}
                    onSelectSubcollection={selectCollection}
                    onMarqueeSelect={selectCollectionsMany}
                    onContextMenuSubcollection={collectionContextMenu}
                    onSectionContextMenu={collectionSectionContextMenu}
                    dragItem={dragItem}
                    onDragItem={setDragItem}
                    onReparentCollection={reparentCollection}
                    onMoveCollection={moveCollection}
                    parentId={selection.collectionId ?? null}
                    onMoveBundlesInto={moveBundlesToCollection}
                    onReorderCollections={
                      // Reorder writes one sibling group; disabled in the
                      // flattened view where cards span multiple parents.
                      headerFlattened
                        ? undefined
                        : (orderedIds) =>
                            reorderCollections.mutate({
                              parentId: selection.collectionId ?? null,
                              orderedIds,
                            })
                    }
                    onOpenSubcollection={(id) => {
                      setSelection({ view: 'all', collectionId: id })
                      clearSelection()
                      setSelectedCollectionIds(new Set())
                      setOpenBundleId(null)
                    }}
                    selectedIds={selectedCollectionIds}
                    zoom={prefs.zoom}
                    subcollapsed={subcollapsed}
                    onToggleSubcollapsed={() => setSubcollapsed((v) => !v)}
                    contentsCount={total}
                    contentsCollapsed={contentsCollapsed}
                    onToggleContents={() => setContentsCollapsed((v) => !v)}
                  />
                )}
                {!(headerCollections.length > 0 && contentsCollapsed) && (
                  <Browser
                    items={filtered}
                    total={total}
                    searchQuery={debouncedSearch.trim() || undefined}
                    emptyState={
                      selection.collectionId && headerCollections.length > 0 && !showSubContents ? (
                        <>
                          <div>No bundles directly in this collection.</div>
                          <div>
                            Open a subcollection above, or tick “Show subcollection contents”.
                          </div>
                        </>
                      ) : selection.collectionId ? (
                        <>
                          <div>This collection is empty.</div>
                          <div>Add bundles to it from the grid or file view.</div>
                        </>
                      ) : undefined
                    }
                    layout={prefs.layout}
                    zoom={prefs.zoom}
                    selectedIds={selectedIds}
                    onSelect={select}
                    onMarqueeSelect={selectMany}
                    onOpen={open}
                    onContextMenu={bundleContextMenu}
                    onEmptyContextMenu={emptyContextMenu}
                    onReorder={
                      // Reordering only makes sense on a non-flattened list (a
                      // single collection's own bundles, or the All tab's
                      // uncategorized bundles) — disabled when contents are flattened.
                      effectiveSort.sort === 'manual' && !headerFlattened
                        ? (orderedIds) =>
                            reorderBundles.mutate({
                              collectionId: manualScopeCollectionId,
                              orderedIds,
                            })
                        : undefined
                    }
                    onBundleDragStart={(ids) => setDragItem({ kind: 'bundles', ids })}
                    onBundleDragEnd={() => setDragItem(null)}
                    isLoading={browse.isLoading}
                    isError={browse.isError}
                    error={browse.error}
                    hasNextPage={browse.hasNextPage}
                    isFetchingNextPage={browse.isFetchingNextPage}
                    fetchNextPage={browse.fetchNextPage}
                  />
                )}
              </>
            )}
          </>
        )}
      </div>

      {mode === 'tags' ? null : mode === 'file' ? (
        <FileInspector entry={fileEntry} />
      ) : selectedCollection ? (
        <CollectionInspector key={selectedCollection.id} collection={selectedCollection} />
      ) : selectedCollectionIds.size > 1 ? (
        <aside className="inspector">
          <div className="state">{selectedCollectionIds.size} collections selected</div>
        </aside>
      ) : selectedIds.size > 1 ? (
        <MultiBundleInspector
          key={[...selectedIds].sort().join(',')}
          ids={[...selectedIds]}
          items={filtered.filter((i) => selectedIds.has(i.id))}
          onClear={clearSelection}
        />
      ) : (
        <Inspector bundleId={activeId} onAddFiles={(id) => setAddFilesBundleId(id)} />
      )}

      <Resizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
      <Resizer side="right" width={inspectorW} setWidth={setInspectorW} min={220} max={480} />

      <ContextMenu state={menu.state} onClose={menu.close} />

      {deletingBundles && (
        <DeleteBundlesDialog
          count={deletingBundles.length}
          pending={deleteBundles.isPending}
          filesReturnToUnbundled={selection.view !== 'unbundled'}
          onCancel={() => setDeletingBundles(null)}
          onConfirm={confirmDeleteBundles}
        />
      )}

      {cleaningCollections && (
        <CleanupOrderDialog
          title="Clean up collection order"
          description="Overwrite the manual order of every collection level with alphabetical order by name."
          choices={[
            { key: 'asc', label: 'Title (A–Z)' },
            { key: 'desc', label: 'Title (Z–A)' },
          ]}
          pending={cleanupCollectionOrder.isPending}
          onCancel={() => setCleaningCollections(false)}
          onConfirm={(key) =>
            cleanupCollectionOrder.mutate(key as 'asc' | 'desc', {
              onSuccess: () => setCleaningCollections(false),
            })
          }
        />
      )}

      {cleaningBundles && (
        <CleanupOrderDialog
          title="Clean up bundle order"
          description={
            manualScopeCollectionId
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
            { key: 'size:desc', label: 'Size (large → small)' },
            { key: 'size:asc', label: 'Size (small → large)' },
            { key: 'file_count:desc', label: 'File Count (most first)' },
            { key: 'file_count:asc', label: 'File Count (fewest first)' },
          ]}
          pending={cleanupBundleOrder.isPending}
          onCancel={() => setCleaningBundles(false)}
          onConfirm={(key) => {
            const [sort, order] = key.split(':') as [
              'date_added' | 'title' | 'rating' | 'size' | 'file_count',
              'asc' | 'desc',
            ]
            cleanupBundleOrder.mutate(
              { collectionId: manualScopeCollectionId, sort, order },
              {
                onSuccess: () => {
                  setCleaningBundles(false)
                  // Land on the manual order the cleanup just wrote.
                  setPrefs({ ...prefs, sort: 'manual', order: 'asc' })
                },
              },
            )
          }}
        />
      )}

      {removingCollections && (
        <RemoveCollectionDialog
          collections={removingCollections}
          hasChildren={(collections.data ?? []).some((c) =>
            removingCollections.some((t) => t.id === c.parent_id),
          )}
          pending={deleteCollection.isPending}
          onCancel={() => setRemovingCollections(null)}
          onConfirm={confirmRemoveCollection}
        />
      )}

      {reviewingGrouping && (
        <GroupingReview
          initialPlanId={reviewPlanId}
          onClose={() => {
            setReviewingGrouping(false)
            setReviewPlanId(null)
          }}
        />
      )}

      {editor && (
        <SmartCollectionEditor
          existing={editor.existing}
          initialDraft={editor.initialDraft}
          onClose={() => setEditor(null)}
          onSaved={(sc) => {
            setEditor(null)
            setSelection({ view: 'all', collectionId: null, smartCollectionId: sc.id })
            clearSelection()
          }}
        />
      )}

      {addingToBundle && (
        <AddToBundleDialog
          selection={addingToBundle}
          onClose={() => setAddingToBundle(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {creatingBundle && (
        <CreateBundleDialog
          selection={creatingBundle}
          onClose={() => setCreatingBundle(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {creatingEmpty && (
        <CreateEmptyBundleDialog
          onClose={() => setCreatingEmpty(false)}
          onCreated={(bundleId) => {
            // Chain into "add files" so the new empty bundle can pull in
            // suggested unbundled files (or be left empty).
            setCreatingEmpty(false)
            setAddFilesBundleId(bundleId)
            setFlash('Created an empty bundle.')
          }}
        />
      )}

      {addFilesBundleId && (
        <AddFilesToBundleDialog
          bundleId={addFilesBundleId}
          onClose={() => setAddFilesBundleId(null)}
          onApplied={onManualBundlingApplied}
        />
      )}

      {flash && (
        <div className="mb-toast" role="status">
          {flash}
        </div>
      )}
    </div>
  )
}
