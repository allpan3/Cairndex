import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { FileBrowserEntry, SortOrder } from '../api/client'
import { useFileBrowser, useUnbundledFiles } from '../api/hooks'
import { formatBytes, formatDate } from '../lib/format'
import type { HostLabels } from '../platform'
import { usePersistentState } from '../state/usePersistentState'
import { ContextMenu } from './ContextMenu'
import { type FileDragProps, fileDragProps } from './dragOut'
import { FileEntryViewer } from './FileEntryViewer'
import { hostFileMenuEntries } from './hostActions'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import { IconCaptions, IconFile, IconFilm, IconFolder, IconImage, IconMusic } from './icons'
import { listRowHeight } from './layout'
import { usePinyinSearch } from './pinyin'
import { type MenuEntry, useContextMenu } from './useContextMenu'
import { type MarqueeRect, rectsIntersect, useMarqueeSelect } from './useMarqueeSelect'

// File Browser mirrors the bundle browser's toolbar, but with file-appropriate
// sort fields (bundles' rating/file-count/date-added don't apply) and only
// grid/list layouts (justified needs image aspect ratios files don't carry).
type FileSort = 'name' | 'type' | 'size' | 'added' | 'modified'
type FileLayout = 'list' | 'grid'

interface FilePrefs {
  layout: FileLayout
  zoom: number // target card width in px (grid only)
  sort: FileSort
  order: SortOrder
}

const DEFAULT_FILE_PREFS: FilePrefs = { layout: 'list', zoom: 200, sort: 'name', order: 'asc' }

const FILE_SORTS: { value: FileSort; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'type', label: 'Type' },
  { value: 'size', label: 'Size' },
  { value: 'added', label: 'Date Added' },
  { value: 'modified', label: 'Date Modified' },
]

interface FileBrowserProps {
  libraryName: string
  // 'browse' = the directory tree; 'unbundled' = the flat "to-bundle queue".
  scope: 'browse' | 'unbundled'
  path: string
  selectedPath: string | null
  onNavigate: (path: string) => void
  onSelectEntry: (entry: FileBrowserEntry | null) => void
  // Manual bundling actions on selected file paths (unlinked ones auto-linked).
  onAddToBundle: (relativePaths: string[]) => void
  onCreateBundle: (relativePaths: string[]) => void
  hostLabels: HostLabels
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Drag file(s) out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
}

/** Breadcrumb segments for a library-root-relative POSIX path. */
function crumbs(path: string): { label: string; path: string }[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))
}

// Inline SVG icons (no font dependency, monochrome via currentColor) chosen by
// directory/media kind.
function entryIcon(entry: FileBrowserEntry) {
  if (entry.kind === 'directory') return <IconFolder />
  switch (entry.media_kind) {
    case 'video':
      return <IconFilm />
    case 'image':
      return <IconImage />
    case 'audio':
      return <IconMusic />
    case 'subtitle':
      return <IconCaptions />
    default:
      return <IconFile />
  }
}

/** Compare two entries by the active sort field (nulls sort last-ish via
 * empty-string / zero fallbacks); direction is applied by the caller. */
function compareEntries(a: FileBrowserEntry, b: FileBrowserEntry, sort: FileSort): number {
  switch (sort) {
    case 'name':
      return a.name.localeCompare(b.name)
    case 'type':
      return (a.extension ?? '').localeCompare(b.extension ?? '') || a.name.localeCompare(b.name)
    case 'size':
      return (a.size_bytes ?? 0) - (b.size_bytes ?? 0) || a.name.localeCompare(b.name)
    case 'added':
      return (a.created_at ?? '').localeCompare(b.created_at ?? '') || a.name.localeCompare(b.name)
    case 'modified':
      return (
        (a.modified_at ?? '').localeCompare(b.modified_at ?? '') || a.name.localeCompare(b.name)
      )
  }
}

/**
 * The physical, library-scoped file browser (ADR-0008). The visible items are
 * real directories and files under the active library's root — not bundle cards.
 * Two scopes: `browse` navigates the directory tree; `unbundled` shows a flat,
 * cross-library list of files awaiting bundling. Files can be right-clicked to
 * add them to / create a bundle (metadata-only; no move/rename/delete on disk).
 */
export function FileBrowser(props: FileBrowserProps) {
  return props.scope === 'unbundled' ? <UnbundledScope {...props} /> : <BrowseScope {...props} />
}

function BrowseScope(props: FileBrowserProps) {
  const { libraryName, path, onNavigate } = props
  const qc = useQueryClient()
  const query = useFileBrowser(path)
  const entries = query.data?.entries ?? []
  const missingFilesUpdated = query.data?.missing_files_updated ?? 0

  // A directory read can persist missing links, so refresh bundle-based views
  useEffect(() => {
    if (missingFilesUpdated === 0) return
    qc.invalidateQueries({ queryKey: ['view-counts'] })
    qc.invalidateQueries({ queryKey: ['browse'] })
    qc.invalidateQueries({ queryKey: ['bundle-files'] })
  }, [missingFilesUpdated, qc, query.dataUpdatedAt])

  const header = (
    <nav className="file-browser__crumbs" aria-label="Breadcrumb">
      <button className="crumb" onClick={() => onNavigate('')} disabled={!path}>
        {libraryName}
      </button>
      {crumbs(path).map((c) => (
        <span key={c.path}>
          <span className="crumb__sep">/</span>
          <button className="crumb" onClick={() => onNavigate(c.path)}>
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  )

  return (
    <div className="file-browser">
      <FileList
        key={`browse:${path}`}
        header={header}
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText="This folder is empty."
        {...props}
      />
    </div>
  )
}

function UnbundledScope(props: FileBrowserProps) {
  const query = useUnbundledFiles()
  const entries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])

  return (
    <div className="file-browser">
      <FileList
        key="unbundled"
        header={<span className="toolbar__title">Unbundled</span>}
        entries={entries}
        isLoading={query.isLoading}
        isError={query.isError}
        errorText={query.error instanceof Error ? query.error.message : undefined}
        emptyText="Nothing to bundle — every file is already in a bundle."
        hasMore={query.hasNextPage}
        isFetchingMore={query.isFetchingNextPage}
        onLoadMore={() => query.fetchNextPage()}
        {...props}
      />
    </div>
  )
}

interface FileListProps extends FileBrowserProps {
  header: ReactNode
  entries: FileBrowserEntry[]
  isLoading: boolean
  isError: boolean
  errorText?: string
  emptyText: string
  hasMore?: boolean
  isFetchingMore?: boolean
  onLoadMore?: () => void
}

/** The selectable, right-clickable table/grid of file/dir entries shared by
 * both scopes, with a bundle-browser-style toolbar (search / sort / layout /
 * zoom). Local selection + search are reset by remount (the caller keys it by
 * scope/path); layout/sort/zoom persist. Single click selects (drives the
 * inspector); double click navigates into a folder or opens a file. Only files
 * participate in the bundling context menu and drag-select. */
function FileList({
  header,
  entries,
  isLoading,
  isError,
  errorText,
  emptyText,
  hasMore,
  isFetchingMore,
  onLoadMore,
  selectedPath,
  onNavigate,
  onSelectEntry,
  onAddToBundle,
  onCreateBundle,
  hostLabels,
  onRevealFile,
  onOpenFile,
  onStartFileDrag,
}: FileListProps) {
  const menu = useContextMenu()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  // Anchor for Shift-range selection (the last plainly-clicked file).
  const [anchor, setAnchor] = useState<string | null>(null)
  const [prefs, setPrefs] = usePersistentState<FilePrefs>('cairndex.filePrefs', DEFAULT_FILE_PREFS)
  const [search, setSearch] = useState('')
  const matchSearch = usePinyinSearch(search)

  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  // Client-side filter (by name) + sort. Directories stay grouped ahead of
  // files (file-manager convention; folders are the navigational containers,
  // analogous to collections). Whole-library / recursive file search is a
  // future backend enhancement — see docs/STATUS.md.
  const visible = useMemo(() => {
    const q = search.trim()
    const filtered = q ? entries.filter((e) => matchSearch(e.name)) : entries
    const dir = prefs.order === 'asc' ? 1 : -1
    const cmp = (a: FileBrowserEntry, b: FileBrowserEntry) => compareEntries(a, b, prefs.sort) * dir
    const dirs = filtered.filter((e) => e.kind === 'directory').sort(cmp)
    const files = filtered.filter((e) => e.kind !== 'directory').sort(cmp)
    return [...dirs, ...files]
  }, [entries, search, prefs.sort, prefs.order, matchSearch])

  const openable = useMemo(() => visible.filter((e) => e.kind === 'file' && e.supported), [visible])
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  // Single click selects (for the inspector); Cmd/Ctrl toggles the entry, Shift
  // selects the inclusive range from the anchor. Both directories and files take
  // part (bundling later filters to files). Navigation/opening is double-click.
  const clickEntry = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    if (e.shiftKey && anchor) {
      const ids = visible.map((v) => v.relative_path)
      const a = ids.indexOf(anchor)
      const b = ids.indexOf(entry.relative_path)
      if (a !== -1 && b !== -1) {
        const [lo, hi] = a < b ? [a, b] : [b, a]
        const range = visible.slice(lo, hi + 1).map((v) => v.relative_path)
        setSelected(new Set(range))
        onSelectEntry(entry)
        return
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.relative_path)) next.delete(entry.relative_path)
        else next.add(entry.relative_path)
        return next
      })
    } else {
      setSelected(new Set([entry.relative_path]))
    }
    setAnchor(entry.relative_path)
    onSelectEntry(entry)
  }

  const openEntry = (entry: FileBrowserEntry) => {
    if (entry.kind === 'directory') {
      onNavigate(entry.relative_path)
      return
    }
    if (entry.supported) {
      const idx = openable.findIndex((e) => e.relative_path === entry.relative_path)
      if (idx >= 0) setOpenIndex(idx)
    }
  }

  const contextRow = (entry: FileBrowserEntry, e: React.MouseEvent) => {
    if (entry.kind === 'directory') return // bundling acts on files only
    const inSelection = selected.has(entry.relative_path)
    // The selection can now include directories (drag/shift-select), so restrict
    // the bundling targets to files.
    const filePaths = new Set(visible.filter((v) => v.kind === 'file').map((v) => v.relative_path))
    const targets = (
      inSelection && selected.size > 1 ? [...selected] : [entry.relative_path]
    ).filter((p) => filePaths.has(p))
    if (!inSelection) {
      setSelected(new Set([entry.relative_path]))
      onSelectEntry(entry)
    }
    const n = targets.length
    const items: MenuEntry[] = [
      {
        label: n > 1 ? `Add ${n} Files to Bundle…` : 'Add to Bundle…',
        onClick: () => onAddToBundle(targets),
      },
      {
        label: n > 1 ? `Create Bundle from ${n} Files…` : 'Create Bundle…',
        onClick: () => onCreateBundle(targets),
      },
    ]
    if (n === 1) {
      const hostItems = hostFileMenuEntries(
        hostLabels,
        { onOpenFile, onRevealFile },
        targets[0] as string,
      )
      if (hostItems.length > 0) items.push(null, ...hostItems)
    }
    menu.open(e, items)
  }

  // Drag-out targets: the whole file selection when dragging a selected file in a
  // multi-selection, else just this file. Directories are never drag sources, and
  // any selected directory is filtered out (mirrors the context-menu rule).
  const dragTargets = (entry: FileBrowserEntry): string[] => {
    const filePaths = new Set(visible.filter((v) => v.kind === 'file').map((v) => v.relative_path))
    const base =
      selected.has(entry.relative_path) && selected.size > 1 ? [...selected] : [entry.relative_path]
    return base.filter((p) => filePaths.has(p))
  }
  const entryDragProps = (entry: FileBrowserEntry): FileDragProps =>
    entry.kind === 'file'
      ? fileDragProps(onStartFileDrag, () => dragTargets(entry))
      : { draggable: false, onDragStart: undefined }

  // Rectangle-intersect against the live DOM rects of every selectable entry
  // (only files carry `data-relpath`) — simpler than Browser.tsx's row-math
  // since the file list/grid isn't virtualized, so every node is mounted.
  const hitTest = (rect: MarqueeRect): string[] => {
    const wrapperEl = wrapperRef.current
    if (!wrapperEl) return []
    const wrapperRect = wrapperEl.getBoundingClientRect()
    const ids: string[] = []
    for (const el of wrapperEl.querySelectorAll<HTMLElement>('[data-relpath]')) {
      const r = el.getBoundingClientRect()
      const cardRect: MarqueeRect = {
        left: r.left - wrapperRect.left,
        top: r.top - wrapperRect.top,
        width: r.width,
        height: r.height,
      }
      if (rectsIntersect(rect, cardRect)) ids.push(el.dataset.relpath as string)
    }
    return ids
  }

  const { marqueeRect, onMouseDown: onBackgroundMouseDown } = useMarqueeSelect({
    getScrollEl: () => scrollEl,
    getWrapperEl: () => wrapperRef.current,
    // Rubber-band from empty space always, and from a file row in list layout
    // (rows fill the width, so there's otherwise nothing to grab); a plain click
    // still selects via the drag threshold. File rows aren't reorder-draggable.
    isBackgroundTarget: (target) => {
      if (target.closest('.file-table__head')) return false
      if (!target.closest('[data-relpath]')) return true
      return prefs.layout === 'list'
    },
    hitTest,
    getBaseSelection: () => selected,
    onChange: (ids) => {
      setSelected(new Set(ids))
      const lastId = ids.at(-1)
      const lastEntry = lastId ? (visible.find((e) => e.relative_path === lastId) ?? null) : null
      onSelectEntry(lastEntry)
    },
  })

  const gridStyle =
    prefs.layout === 'grid'
      ? {
          gridTemplateColumns: `repeat(auto-fill, minmax(${prefs.zoom}px, 1fr))`,
          gridAutoRows: `${Math.round(prefs.zoom * 0.78)}px`,
        }
      : undefined

  return (
    <>
      <div className="toolbar">
        {header}
        <span className="toolbar__count">{visible.length.toLocaleString()} items</span>
        <span className="toolbar__spacer" />

        <input
          type="search"
          placeholder="Search files…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search files"
          title="Filter files in this view by name"
        />

        <select
          value={prefs.sort}
          onChange={(e) => setPrefs({ ...prefs, sort: e.target.value as FileSort })}
          aria-label="Sort by"
        >
          {FILE_SORTS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          className="seg"
          style={{ padding: '5px 8px', cursor: 'pointer' }}
          onClick={() => setPrefs({ ...prefs, order: prefs.order === 'desc' ? 'asc' : 'desc' })}
          aria-label="Toggle sort order"
          title="Toggle sort order"
        >
          {prefs.order === 'desc' ? '↓' : '↑'}
        </button>

        <div className="seg" role="group" aria-label="Layout">
          <button
            className={prefs.layout === 'grid' ? 'is-active' : ''}
            onClick={() => setPrefs({ ...prefs, layout: 'grid' })}
            title="Grid"
            aria-label="Grid"
            aria-pressed={prefs.layout === 'grid'}
          >
            ▦
          </button>
          <button
            className={prefs.layout === 'list' ? 'is-active' : ''}
            onClick={() => setPrefs({ ...prefs, layout: 'list' })}
            title="List"
            aria-label="List"
            aria-pressed={prefs.layout === 'list'}
          >
            ☰
          </button>
        </div>

        {/* Always shown — drives card size in grid, row height in list — so the
            controls to its left don't shift when switching layouts. */}
        <div className="zoom">
          <input
            type="range"
            min={120}
            max={360}
            step={10}
            value={prefs.zoom}
            onChange={(e) => setPrefs({ ...prefs, zoom: Number(e.target.value) })}
            aria-label="Zoom"
          />
        </div>
      </div>

      <div
        className={`file-browser__body${marqueeRect ? ' file-browser__body--dragging' : ''}`}
        ref={setScrollEl}
        onMouseDown={onBackgroundMouseDown}
      >
        {isLoading ? (
          <div className="empty">Loading…</div>
        ) : isError ? (
          <div className="empty empty--error">{errorText ?? 'Could not load files.'}</div>
        ) : entries.length === 0 ? (
          <div className="empty">{emptyText}</div>
        ) : visible.length === 0 ? (
          <div className="empty">No files match “{search}”.</div>
        ) : (
          <>
            <div className="file-browser__wrapper" ref={wrapperRef}>
              {marqueeRect && (
                <div
                  className="marquee"
                  style={{
                    position: 'absolute',
                    left: marqueeRect.left,
                    top: marqueeRect.top,
                    width: marqueeRect.width,
                    height: marqueeRect.height,
                    pointerEvents: 'none',
                  }}
                />
              )}
              {prefs.layout === 'list' ? (
                <div
                  className="file-table"
                  role="table"
                  style={{ ['--file-row-h' as string]: `${listRowHeight(prefs.zoom)}px` }}
                >
                  <div className="file-table__head" role="row">
                    <span role="columnheader">Name</span>
                    <span role="columnheader">Type</span>
                    <span className="file-table__num" role="columnheader">
                      Size
                    </span>
                    <span role="columnheader">Date Added</span>
                    <span role="columnheader">Date Modified</span>
                  </div>
                  {visible.map((entry) => (
                    <FileRow
                      key={entry.relative_path}
                      entry={entry}
                      selected={
                        selected.has(entry.relative_path) || entry.relative_path === selectedPath
                      }
                      onClick={(e) => clickEntry(entry, e)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => contextRow(entry, e)}
                      dragProps={entryDragProps(entry)}
                    />
                  ))}
                </div>
              ) : (
                <div className="file-grid" style={gridStyle}>
                  {visible.map((entry) => (
                    <FileCard
                      key={entry.relative_path}
                      entry={entry}
                      selected={
                        selected.has(entry.relative_path) || entry.relative_path === selectedPath
                      }
                      onClick={(e) => clickEntry(entry, e)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => contextRow(entry, e)}
                      previewDisabled={marqueeRect !== null || menu.state !== null}
                      dragProps={entryDragProps(entry)}
                    />
                  ))}
                </div>
              )}
            </div>
            {hasMore && (
              <button
                className="btn file-browser__more"
                onClick={onLoadMore}
                disabled={isFetchingMore}
              >
                {isFetchingMore ? 'Loading…' : 'Load more'}
              </button>
            )}
          </>
        )}

        <ContextMenu state={menu.state} onClose={menu.close} />

        {openIndex !== null && (
          <FileEntryViewer
            files={openable}
            index={openIndex}
            onIndex={setOpenIndex}
            onClose={() => setOpenIndex(null)}
          />
        )}
      </div>
    </>
  )
}

function FileRow({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  dragProps,
}: {
  entry: FileBrowserEntry
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragProps: FileDragProps
}) {
  const isDir = entry.kind === 'directory'
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="row"
      aria-selected={selected}
      data-relpath={entry.relative_path}
      {...dragProps}
    >
      <span className="file-row__name">
        <span className="file-row__icon">{entryIcon(entry)}</span>
        <span className="file-row__text">{entry.name}</span>
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {/* Bundle status: flag files that still need attention. A file already in
            a confirmed bundle shows no status badge. */}
        {!isDir && !entry.linked && <span className="badge badge--warn">unlinked</span>}
        {!isDir && entry.unbundled && <span className="badge badge--warn">unbundled</span>}
      </span>
      <span className="file-row__type">{isDir ? 'Folder' : (entry.extension ?? 'file')}</span>
      <span className="file-table__num">{isDir ? '' : formatBytes(entry.size_bytes)}</span>
      <span className="file-row__added">
        {entry.created_at ? formatDate(entry.created_at) : ''}
      </span>
      <span className="file-row__modified">
        {entry.modified_at ? formatDate(entry.modified_at) : ''}
      </span>
    </div>
  )
}

/** Card tile for grid layout — same visual language as BundleCard (icon in
 * place of a thumbnail, since physical files don't carry a cover image). */
function FileCard({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
  previewDisabled,
  dragProps,
}: {
  entry: FileBrowserEntry
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
  previewDisabled: boolean
  dragProps: FileDragProps
}) {
  const isDir = entry.kind === 'directory'
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      entry.media_kind === 'video' && entry.file_id && entry.duration
        ? {
            mediaKind: 'video',
            fileId: entry.file_id,
            mimeType: entry.mime_type,
            relativePath: entry.relative_path,
            container: entry.container,
            videoCodec: entry.video_codec,
            audioCodec: entry.audio_codec,
            duration: entry.duration,
            startTime: entry.resume_position,
          }
        : null,
    [
      entry.audio_codec,
      entry.container,
      entry.duration,
      entry.file_id,
      entry.media_kind,
      entry.mime_type,
      entry.relative_path,
      entry.resume_position,
      entry.video_codec,
    ],
  )
  return (
    <div
      className={`card${selected ? ' card--selected' : ''}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      role="gridcell"
      aria-selected={selected}
      data-relpath={entry.relative_path}
      {...dragProps}
    >
      <HoverPreview source={previewSource} disabled={previewDisabled} className="card__thumb">
        <div className="card__placeholder card__placeholder--icon">{entryIcon(entry)}</div>
        {!isDir && !entry.linked && (
          <span className="card__badge card__badge--missing">unlinked</span>
        )}
        {!isDir && entry.linked && entry.unbundled && (
          <span className="card__badge card__badge--review">unbundled</span>
        )}
      </HoverPreview>
      <div className="card__meta">
        <div className="card__title">{entry.name}</div>
        <div className="card__sub">
          <span>{isDir ? 'Folder' : (entry.extension ?? 'file')}</span>
          {!isDir && <span>{formatBytes(entry.size_bytes)}</span>}
        </div>
      </div>
    </div>
  )
}
