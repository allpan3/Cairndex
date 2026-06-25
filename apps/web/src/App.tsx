import { useCallback, useEffect, useMemo, useState } from 'react'

import { useBrowse, useFolderCounts, useFolders, useViewCounts } from './api/hooks'
import { Browser } from './app/Browser'
import { Inspector } from './app/Inspector'
import { Sidebar } from './app/Sidebar'
import { Toolbar } from './app/Toolbar'
import { DEFAULT_PREFS, SYSTEM_VIEWS, type BrowsePrefs, type Selection } from './app/types'
import { usePersistentState } from './state/usePersistentState'

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
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const counts = useViewCounts()
  const folders = useFolders()
  const folderCounts = useFolderCounts()

  const browse = useBrowse({
    view: selection.view,
    folderId: selection.folderId,
    includeDescendants: selection.folderId !== null,
    sort: prefs.sort,
    order: prefs.order,
    limit: 100,
  })

  const items = useMemo(() => browse.data?.pages.flatMap((p) => p.items) ?? [], [browse.data])
  const total = browse.data?.pages[0]?.total ?? 0
  const filtered = useMemo(() => {
    if (!search.trim()) return items
    const q = search.toLowerCase()
    return items.filter((i) => (i.title ?? '').toLowerCase().includes(q))
  }, [items, search])

  const title = useMemo(() => {
    if (selection.folderId) {
      return folders.data?.find((f) => f.id === selection.folderId)?.name ?? 'Folder'
    }
    return SYSTEM_VIEWS.find((v) => v.view === selection.view)?.label ?? 'All'
  }, [selection, folders.data])

  // Linear keyboard navigation over the loaded set.
  const moveSelection = useCallback(
    (delta: number) => {
      if (filtered.length === 0) return
      const idx = filtered.findIndex((i) => i.id === selectedId)
      const next = Math.max(0, Math.min(filtered.length - 1, idx < 0 ? 0 : idx + delta))
      const target = filtered[next]
      if (target) {
        setSelectedId(target.id)
        document
          .querySelector(`[data-bundle-id="${target.id}"]`)
          ?.scrollIntoView({ block: 'nearest' })
      }
    },
    [filtered, selectedId],
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
        setSelectedId(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [moveSelection])

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
          setSelectedId(null)
        }}
        counts={counts.data}
        folders={folders.data ?? []}
        folderCounts={folderCounts.data}
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
        <Browser
          items={filtered}
          total={total}
          layout={prefs.layout}
          zoom={prefs.zoom}
          selectedId={selectedId}
          onSelect={setSelectedId}
          isLoading={browse.isLoading}
          isError={browse.isError}
          error={browse.error}
          hasNextPage={browse.hasNextPage}
          isFetchingNextPage={browse.isFetchingNextPage}
          fetchNextPage={browse.fetchNextPage}
        />
      </div>

      <Inspector bundleId={selectedId} />

      <Resizer side="left" width={sidebarW} setWidth={setSidebarW} min={180} max={400} />
      <Resizer side="right" width={inspectorW} setWidth={setInspectorW} min={220} max={480} />
    </div>
  )
}
