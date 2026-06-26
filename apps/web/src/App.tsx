import { useCallback, useEffect, useMemo, useState } from 'react'

import type { SmartFolderRead } from './api/client'
import { useBrowse, useFolderCounts, useFolders, useSmartFolders, useViewCounts } from './api/hooks'
import { BatchBar } from './app/BatchBar'
import { Browser } from './app/Browser'
import { EagleImport } from './app/EagleImport'
import { type FilterDraft, emptyDraft } from './app/filterModel'
import { Inspector } from './app/Inspector'
import { Sidebar } from './app/Sidebar'
import { SmartFolderEditor } from './app/SmartFolderEditor'
import { Toolbar } from './app/Toolbar'
import { DEFAULT_PREFS, SYSTEM_VIEWS, type BrowsePrefs, type Selection } from './app/types'
import { usePersistentState } from './state/usePersistentState'

interface EditorState {
  existing?: SmartFolderRead | null
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

export default function App() {
  const [prefs, setPrefs] = usePersistentState<BrowsePrefs>('cairndex.prefs', DEFAULT_PREFS)
  const [sidebarW, setSidebarW] = usePersistentState('cairndex.sidebarW', 240)
  const [inspectorW, setInspectorW] = usePersistentState('cairndex.inspectorW', 300)

  const [selection, setSelection] = useState<Selection>({ view: 'all', folderId: null })
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activeId, setActiveId] = useState<string | null>(null) // anchor for inspector + keyboard
  const [search, setSearch] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [importing, setImporting] = useState(false)

  const counts = useViewCounts()
  const folders = useFolders()
  const folderCounts = useFolderCounts()
  const smartFolders = useSmartFolders()

  // A selected Smart Folder drives browsing through its saved filter AST, which
  // compiles via the exact path POST /bundles/browse uses for ad-hoc filters.
  const activeSmartFolder =
    smartFolders.data?.find((sf) => sf.id === selection.smartFolderId) ?? null

  const browse = useBrowse({
    view: selection.view,
    folderId: selection.folderId,
    includeDescendants: selection.folderId !== null,
    sort: prefs.sort,
    order: prefs.order,
    limit: 100,
    filter: activeSmartFolder?.filter ?? null,
  })

  const items = useMemo(() => browse.data?.pages.flatMap((p) => p.items) ?? [], [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter((i) => (i.title ?? '').toLowerCase().includes(q))
  }, [items, search])

  const title = useMemo(() => {
    if (activeSmartFolder) return activeSmartFolder.name
    if (selection.folderId) {
      return folders.data?.find((f) => f.id === selection.folderId)?.name ?? 'Folder'
    }
    return SYSTEM_VIEWS.find((v) => v.view === selection.view)?.label ?? 'All'
  }, [selection, folders.data, activeSmartFolder])

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

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    setActiveId(null)
  }, [])

  // Linear keyboard navigation over the loaded set (single-selects).
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
  }, [moveSelection, clearSelection])

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
        selection={selection}
        onSelect={(s) => {
          setSelection(s)
          clearSelection()
        }}
        counts={counts.data}
        folders={folders.data ?? []}
        folderCounts={folderCounts.data}
        smartFolders={smartFolders.data ?? []}
        onNewSmartFolder={() => setEditor({ initialDraft: emptyDraft() })}
        onEditSmartFolder={(sf) => setEditor({ existing: sf })}
        onImport={() => setImporting(true)}
      />

      <div className="center">
        <Toolbar
          title={title}
          total={total}
          search={search}
          onSearch={setSearch}
          prefs={prefs}
          onPrefs={setPrefs}
        />
        {selectedIds.size >= 2 && <BatchBar ids={[...selectedIds]} onClear={clearSelection} />}
        <Browser
          items={filtered}
          total={total}
          layout={prefs.layout}
          zoom={prefs.zoom}
          selectedIds={selectedIds}
          onSelect={select}
          isLoading={browse.isLoading}
          isError={browse.isError}
          error={browse.error}
          hasNextPage={browse.hasNextPage}
          isFetchingNextPage={browse.isFetchingNextPage}
          fetchNextPage={browse.fetchNextPage}
        />
      </div>

      <Inspector bundleId={activeId} />

      <Resizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
      <Resizer side="right" width={inspectorW} setWidth={setInspectorW} min={220} max={480} />

      {importing && <EagleImport onClose={() => setImporting(false)} />}

      {editor && (
        <SmartFolderEditor
          existing={editor.existing}
          initialDraft={editor.initialDraft}
          onClose={() => setEditor(null)}
          onSaved={(sf) => {
            setEditor(null)
            setSelection({ view: 'all', folderId: null, smartFolderId: sf.id })
            clearSelection()
          }}
        />
      )}
    </div>
  )
}
