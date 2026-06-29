import { useCallback, useEffect, useMemo, useState } from 'react'

import type { CollectionRead, FileViewEntry, LibraryRead, SmartCollectionRead } from './api/client'
import { setActiveLibraryId } from './api/client'
import {
  useBatchUpdate,
  useBrowse,
  useCollectionCounts,
  useCollections,
  useDeleteBundles,
  useDeleteCollection,
  useLibraries,
  useProbe,
  useScan,
  useSmartCollectionMutations,
  useSmartCollections,
  useUpdateLibrary,
  useViewCounts,
} from './api/hooks'
import { ContextMenu } from './app/ContextMenu'
import { type MenuEntry, useContextMenu } from './app/useContextMenu'
import { BatchBar } from './app/BatchBar'
import { Browser } from './app/Browser'
import { BundleAlbum } from './app/BundleAlbum'
import { FileInspector } from './app/FileInspector'
import { FileView } from './app/FileView'
import { GroupingReview } from './app/GroupingReview'
import { LibraryManager } from './app/LibraryManager'
import { type FilterDraft, emptyDraft } from './app/filterModel'
import { Inspector } from './app/Inspector'
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

  return (
    <>
      <Workspace
        key={libraryId}
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={setChosenId}
        onManage={() => setManaging(true)}
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
}

function Workspace({ libraries, libraryId, onChangeLibrary, onManage }: WorkspaceProps) {
  const [prefs, setPrefs] = usePersistentState<BrowsePrefs>('cairndex.prefs', DEFAULT_PREFS)
  const [sidebarW, setSidebarW] = usePersistentState('cairndex.sidebarW', 240)
  const [inspectorW, setInspectorW] = usePersistentState('cairndex.inspectorW', 300)

  const [selection, setSelection] = useState<Selection>({ view: 'all', collectionId: null })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null)
  const [openBundleId, setOpenBundleId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [reviewingGrouping, setReviewingGrouping] = useState(false)
  const [reviewPlanId, setReviewPlanId] = useState<string | null>(null)
  const [removingCollection, setRemovingCollection] = useState<CollectionRead | null>(null)

  const [mode, setMode] = useState<AppMode>('collection')
  const [filePath, setFilePath] = useState('')
  const [fileEntry, setFileEntry] = useState<FileViewEntry | null>(null)

  const collections = useCollections()
  const smartCollections = useSmartCollections()
  const counts = useViewCounts()
  const collectionCounts = useCollectionCounts()
  const updateLibrary = useUpdateLibrary({
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const scanFiles = useScan({
    onGroupingPlan: (planId) => {
      setReviewPlanId(planId)
      setReviewingGrouping(true)
    },
  })
  const probe = useProbe()
  const deleteBundles = useDeleteBundles()
  const deleteCollection = useDeleteCollection()
  const smartCollectionMutations = useSmartCollectionMutations()
  const batch = useBatchUpdate()
  const menu = useContextMenu()

  const libraryName = libraries.find((l) => l.id === libraryId)?.name ?? 'Library'

  const activeSmartCollection =
    smartCollections.data?.find((sc) => sc.id === selection.smartCollectionId) ?? null

  const browse = useBrowse({
    view: selection.view,
    collectionId: selection.collectionId,
    includeDescendants: selection.collectionId !== null,
    sort: prefs.sort,
    order: prefs.order,
    limit: 100,
    filter: activeSmartCollection?.filter ?? null,
  })

  const items = useMemo(() => browse.data?.pages.flatMap((p) => p.items) ?? [], [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter((i) => (i.title ?? '').toLowerCase().includes(q))
  }, [items, search])

  const title = useMemo(() => {
    if (activeSmartCollection) return activeSmartCollection.name
    if (selection.collectionId) {
      return collections.data?.find((c) => c.id === selection.collectionId)?.name ?? 'Collection'
    }
    return SYSTEM_VIEWS.find((v) => v.view === selection.view)?.label ?? 'All'
  }, [selection, collections.data, activeSmartCollection])

  const select = useCallback((id: string, e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    } else {
      setSelectedIds(new Set([id]))
    }
    setActiveId(id)
  }, [])

  const open = useCallback((id: string) => {
    setSelectedIds(new Set([id]))
    setActiveId(id)
    setOpenBundleId(id)
  }, [])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  // Right-click on a bundle card/row. Operate on the whole selection when the
  // clicked card is part of a multi-selection; otherwise target (and select)
  // just this one. Removal is metadata-only — files are never touched.
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
          label: n > 1 ? `Remove ${n} from this collection` : 'Remove from this collection',
          onClick: () =>
            batch.mutate({ bundle_ids: targets, remove_collection_ids: [collectionId] }),
        })
      }
      items.push(null, {
        label: n > 1 ? `Delete ${n} bundles` : 'Delete bundle',
        danger: true,
        onClick: () => {
          const ok = window.confirm(
            `Delete ${n > 1 ? `${n} bundles` : 'this bundle'}? This removes Cairndex ` +
              'metadata only — the files stay on disk.',
          )
          if (!ok) return
          deleteBundles.mutate(targets, {
            onSuccess: () => {
              clearSelection()
              if (openBundleId && targets.includes(openBundleId)) setOpenBundleId(null)
            },
          })
        },
      })
      menu.open(e, items)
    },
    [
      selectedIds,
      selection.collectionId,
      open,
      batch,
      deleteBundles,
      clearSelection,
      openBundleId,
      menu,
    ],
  )

  // Removal is confirmed in a dialog (RemoveCollectionDialog) so the owner can
  // choose whether to also remove subcollections; the menu item just opens it.
  const removeCollection = useCallback(
    (collection: CollectionRead) => setRemovingCollection(collection),
    [],
  )

  const confirmRemoveCollection = useCallback(
    (cascade: boolean) => {
      const target = removingCollection
      if (!target) return
      deleteCollection.mutate(
        { id: target.id, cascade },
        {
          onSuccess: () => {
            setRemovingCollection(null)
            // If the view is on the removed collection (or, when cascading, on
            // one of its now-gone descendants), fall back to All.
            const affected = cascade
              ? collectionSubtreeIds(collections.data ?? [], target.id)
              : new Set([target.id])
            if (selection.collectionId && affected.has(selection.collectionId)) {
              setSelection({ view: 'all', collectionId: null })
            }
          },
        },
      )
    },
    [removingCollection, deleteCollection, collections.data, selection.collectionId],
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
      className="app"
      style={
        {
          ['--sidebar-w']: `${sidebarW}px`,
          ['--inspector-w']: `${inspectorW}px`,
        } as React.CSSProperties
      }
    >
      <Sidebar
        mode={mode}
        onMode={setMode}
        libraries={libraries}
        libraryId={libraryId}
        onChangeLibrary={onChangeLibrary}
        onManageLibraries={onManage}
        onUpdateLibrary={() => updateLibrary.mutate()}
        updating={updateLibrary.isPending}
        onScanFiles={() => scanFiles.mutate()}
        scanningFiles={scanFiles.isPending}
        onProbe={() => probe.mutate()}
        probing={probe.isPending}
        onReviewGrouping={() => {
          setReviewPlanId(null)
          setReviewingGrouping(true)
        }}
        selection={selection}
        onSelect={(s) => {
          setMode('collection')
          setSelection(s)
          clearSelection()
          setOpenBundleId(null)
        }}
        counts={counts.data}
        collections={collections.data ?? []}
        collectionCounts={collectionCounts.data}
        onDeleteCollection={removeCollection}
        smartCollections={smartCollections.data ?? []}
        onNewSmartCollection={() => setEditor({ initialDraft: emptyDraft() })}
        onEditSmartCollection={(sc) => setEditor({ existing: sc })}
        onDeleteSmartCollection={removeSmartCollection}
      />

      <div className="center">
        {mode === 'file' ? (
          <FileView
            libraryName={libraryName}
            path={filePath}
            selectedPath={fileEntry?.relative_path ?? null}
            onNavigate={(path) => {
              setFilePath(path)
              setFileEntry(null)
            }}
            onSelectEntry={setFileEntry}
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
            />
            {selectedIds.size >= 2 && !openBundleId && (
              <BatchBar ids={[...selectedIds]} onClear={clearSelection} />
            )}
            {openBundleId ? (
              <BundleAlbum bundleId={openBundleId} onBack={() => setOpenBundleId(null)} />
            ) : (
              <Browser
                items={filtered}
                total={total}
                layout={prefs.layout}
                zoom={prefs.zoom}
                selectedIds={selectedIds}
                onSelect={select}
                onOpen={open}
                onContextMenu={bundleContextMenu}
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
      </div>

      {mode === 'file' ? <FileInspector entry={fileEntry} /> : <Inspector bundleId={activeId} />}

      <Resizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
      <Resizer side="right" width={inspectorW} setWidth={setInspectorW} min={220} max={480} />

      <ContextMenu state={menu.state} onClose={menu.close} />

      {removingCollection && (
        <RemoveCollectionDialog
          collection={removingCollection}
          hasChildren={(collections.data ?? []).some((c) => c.parent_id === removingCollection.id)}
          pending={deleteCollection.isPending}
          onCancel={() => setRemovingCollection(null)}
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
    </div>
  )
}
