import { useCallback, useEffect, useMemo, useState } from 'react'

import type { FileViewEntry, LibraryRead, SmartCollectionRead } from './api/client'
import { setActiveLibraryId } from './api/client'
import {
  useBrowse,
  useCollectionCounts,
  useCollections,
  useLibraries,
  useProbe,
  useScan,
  useThumbnails,
  useSmartCollections,
  useViewCounts,
} from './api/hooks'
import { BatchBar } from './app/BatchBar'
import { Browser } from './app/Browser'
import { BundleAlbum } from './app/BundleAlbum'
import { FileInspector } from './app/FileInspector'
import { FileView } from './app/FileView'
import { LibraryManager } from './app/LibraryManager'
import { type FilterDraft, emptyDraft } from './app/filterModel'
import { Inspector } from './app/Inspector'
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
    // Forced manager: no library yet. Creating/registering one re-renders into
    // the workspace once the list refreshes.
    return <LibraryManager onClose={() => {}} />
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

  const [mode, setMode] = useState<AppMode>('collection')
  const [filePath, setFilePath] = useState('')
  const [fileEntry, setFileEntry] = useState<FileViewEntry | null>(null)

  const collections = useCollections()
  const smartCollections = useSmartCollections()
  const counts = useViewCounts()
  const collectionCounts = useCollectionCounts()
  const scan = useScan()
  const probe = useProbe()
  const thumbnails = useThumbnails()

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
        onScan={() => scan.mutate()}
        scanning={scan.isPending}
        onProbe={() => probe.mutate()}
        probing={probe.isPending}
        onThumbnails={() => thumbnails.mutate()}
        thumbnailing={thumbnails.isPending}
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
        smartCollections={smartCollections.data ?? []}
        onNewSmartCollection={() => setEditor({ initialDraft: emptyDraft() })}
        onEditSmartCollection={(sc) => setEditor({ existing: sc })}
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
