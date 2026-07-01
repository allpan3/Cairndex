import { useMemo, useState } from 'react'

import type { FileViewEntry } from '../api/client'
import { useFileView, useUnbundledFiles } from '../api/hooks'
import { formatBytes, formatDate } from '../lib/format'
import { ContextMenu } from './ContextMenu'
import { FileEntryViewer } from './FileEntryViewer'
import { IconCaptions, IconFile, IconFilm, IconFolder, IconImage, IconMusic } from './icons'
import { type MenuEntry, useContextMenu } from './useContextMenu'

interface FileViewProps {
  libraryName: string
  // 'browse' = the directory tree; 'unbundled' = the flat "to-bundle queue".
  scope: 'browse' | 'unbundled'
  path: string
  selectedPath: string | null
  onNavigate: (path: string) => void
  onSelectEntry: (entry: FileViewEntry | null) => void
  // Manual bundling actions on selected file paths (unlinked ones auto-linked).
  onAddToBundle: (relativePaths: string[]) => void
  onCreateBundle: (relativePaths: string[]) => void
}

/** Breadcrumb segments for a library-root-relative POSIX path. */
function crumbs(path: string): { label: string; path: string }[] {
  if (!path) return []
  const parts = path.split('/')
  return parts.map((label, i) => ({ label, path: parts.slice(0, i + 1).join('/') }))
}

// Inline SVG icons (no font dependency, monochrome via currentColor) chosen by
// directory/media kind.
function entryIcon(entry: FileViewEntry) {
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

/**
 * The physical, library-scoped file browser (ADR-0008). The visible items are
 * real directories and files under the active library's root — not bundle cards.
 * Two scopes: `browse` navigates the directory tree; `unbundled` shows a flat,
 * cross-library list of files awaiting bundling. Files can be right-clicked to
 * add them to / create a bundle (metadata-only; no move/rename/delete on disk).
 */
export function FileView(props: FileViewProps) {
  return props.scope === 'unbundled' ? <UnbundledScope {...props} /> : <BrowseScope {...props} />
}

function BrowseScope(props: FileViewProps) {
  const { libraryName, path, onNavigate } = props
  const query = useFileView(path)
  const entries = query.data?.entries ?? []

  return (
    <div className="file-view">
      <div className="file-view__bar">
        <nav className="file-view__crumbs" aria-label="Breadcrumb">
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
      </div>
      <FileList
        key={`browse:${path}`}
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

function UnbundledScope(props: FileViewProps) {
  const query = useUnbundledFiles()
  const entries = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data])
  const total = query.data?.pages[0]?.total ?? 0

  return (
    <div className="file-view">
      <div className="file-view__bar">
        <span className="file-view__title">Unbundled</span>
        <span className="file-view__hint">
          {total} file{total === 1 ? '' : 's'} awaiting bundling — right-click to bundle
        </span>
      </div>
      <FileList
        key="unbundled"
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

interface FileListProps extends FileViewProps {
  entries: FileViewEntry[]
  isLoading: boolean
  isError: boolean
  errorText?: string
  emptyText: string
  hasMore?: boolean
  isFetchingMore?: boolean
  onLoadMore?: () => void
}

/** The selectable, right-clickable table of file/dir rows shared by both scopes.
 * Local selection state is reset by remount (the caller keys it by scope/path). */
function FileList({
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
}: FileListProps) {
  const menu = useContextMenu()
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const openable = useMemo(() => entries.filter((e) => e.kind === 'file' && e.supported), [entries])
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const clickRow = (entry: FileViewEntry, e: React.MouseEvent) => {
    if (entry.kind === 'directory') {
      onNavigate(entry.relative_path)
      return
    }
    if (e.metaKey || e.ctrlKey || e.shiftKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.relative_path)) next.delete(entry.relative_path)
        else next.add(entry.relative_path)
        return next
      })
    } else {
      setSelected(new Set([entry.relative_path]))
    }
    onSelectEntry(entry)
  }

  const contextRow = (entry: FileViewEntry, e: React.MouseEvent) => {
    if (entry.kind === 'directory') return // bundling acts on files only
    const inSelection = selected.has(entry.relative_path)
    const targets = inSelection && selected.size > 1 ? [...selected] : [entry.relative_path]
    if (!inSelection) {
      setSelected(new Set([entry.relative_path]))
      onSelectEntry(entry)
    }
    const n = targets.length
    const items: MenuEntry[] = [
      {
        label: n > 1 ? `Add ${n} files to bundle…` : 'Add to Bundle…',
        onClick: () => onAddToBundle(targets),
      },
      {
        label: n > 1 ? `Create bundle from ${n} files…` : 'Create Bundle…',
        onClick: () => onCreateBundle(targets),
      },
    ]
    menu.open(e, items)
  }

  const openFile = (entry: FileViewEntry) => {
    const idx = openable.findIndex((e) => e.relative_path === entry.relative_path)
    if (idx >= 0) setOpenIndex(idx)
  }

  return (
    <div className="file-view__body">
      {isLoading ? (
        <div className="empty">Loading…</div>
      ) : isError ? (
        <div className="empty empty--error">{errorText ?? 'Could not load files.'}</div>
      ) : entries.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <>
          <div className="file-table" role="table">
            <div className="file-table__head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span className="file-table__num" role="columnheader">
                Size
              </span>
              <span role="columnheader">Modified</span>
            </div>
            {entries.map((entry) => (
              <FileRow
                key={entry.relative_path}
                entry={entry}
                selected={selected.has(entry.relative_path) || entry.relative_path === selectedPath}
                onClick={(e) => clickRow(entry, e)}
                onDoubleClick={() =>
                  entry.kind === 'directory'
                    ? onNavigate(entry.relative_path)
                    : entry.supported && openFile(entry)
                }
                onContextMenu={(e) => contextRow(entry, e)}
              />
            ))}
          </div>
          {hasMore && (
            <button className="btn file-view__more" onClick={onLoadMore} disabled={isFetchingMore}>
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
  )
}

function FileRow({
  entry,
  selected,
  onClick,
  onDoubleClick,
  onContextMenu,
}: {
  entry: FileViewEntry
  selected: boolean
  onClick: (e: React.MouseEvent) => void
  onDoubleClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
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
    >
      <span className="file-row__name">
        <span className="file-row__icon">{entryIcon(entry)}</span>
        <span className="file-row__text">{entry.name}</span>
        {!isDir && entry.supported && <span className="badge badge--ok">openable</span>}
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {/* Bundle status: flag files that still need attention. A file already in
            a confirmed bundle shows no status badge. */}
        {!isDir && !entry.linked && <span className="badge badge--warn">unlinked</span>}
        {!isDir && entry.unbundled && <span className="badge badge--warn">unbundled</span>}
      </span>
      <span className="file-row__type">{isDir ? 'Folder' : (entry.extension ?? 'file')}</span>
      <span className="file-table__num">{isDir ? '' : formatBytes(entry.size_bytes)}</span>
      <span className="file-row__modified">
        {entry.modified_at ? formatDate(entry.modified_at) : ''}
      </span>
    </div>
  )
}
