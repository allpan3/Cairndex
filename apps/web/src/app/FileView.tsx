import { useMemo, useState } from 'react'

import type { FileViewEntry, StorageRootRead } from '../api/client'
import { useFileView } from '../api/hooks'
import { formatBytes, formatDate } from '../lib/format'
import { FileEntryViewer } from './FileEntryViewer'
import { IconCaptions, IconFile, IconFilm, IconFolder, IconImage, IconMusic } from './icons'
import type { FileLocation } from './types'

interface FileViewProps {
  roots: StorageRootRead[]
  location: FileLocation
  selectedPath: string | null
  onNavigate: (path: string) => void
  onSelectEntry: (entry: FileViewEntry | null) => void
  onManageLibraries: () => void
}

/** Breadcrumb segments for a root-relative POSIX path. */
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
 * Read-only File View: a physical, storage-root-scoped filesystem browser.
 * Distinct from the bundle-first Collection View — the visible items here are
 * real directories and files. No move/rename/delete controls exist. Double-
 * clicking a previewable file opens a read-only lightbox.
 */
export function FileView({
  roots,
  location,
  selectedPath,
  onNavigate,
  onSelectEntry,
  onManageLibraries,
}: FileViewProps) {
  const { rootId, path } = location
  const query = useFileView(rootId, path)
  const activeRoot = roots.find((r) => r.id === rootId) ?? null
  const unavailable = activeRoot?.status === 'unavailable'

  // Previewable files in this folder, in display order, for the lightbox to
  // step through with the arrow keys. Index into this list, not the full entry
  // list, so navigation skips directories and unsupported files.
  const openable = useMemo(
    () => (query.data?.entries ?? []).filter((e) => e.kind === 'file' && e.supported),
    [query.data],
  )
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  const openFile = (entry: FileViewEntry) => {
    const idx = openable.findIndex((e) => e.relative_path === entry.relative_path)
    if (idx >= 0) setOpenIndex(idx)
  }

  return (
    <div className="file-view">
      <div className="file-view__bar">
        <nav className="file-view__crumbs" aria-label="Breadcrumb">
          <button className="crumb" onClick={() => onNavigate('')} disabled={!path}>
            {activeRoot?.name ?? 'Root'}
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

      <div className="file-view__body">
        {rootId === null ? (
          <div className="empty">
            <p>No libraries yet.</p>
            <button className="btn btn--primary" onClick={onManageLibraries}>
              Add a library
            </button>
          </div>
        ) : unavailable ? (
          <div className="empty empty--error">
            <p>This library is currently unavailable.</p>
            <p className="empty__hint">
              Its folder may be offline or was moved or renamed. Reconnect it (or fix the path in
              Libraries), then rescan.
            </p>
          </div>
        ) : query.isLoading ? (
          <div className="empty">Loading…</div>
        ) : query.isError ? (
          <div className="empty empty--error">{(query.error as Error).message}</div>
        ) : (query.data?.entries.length ?? 0) === 0 ? (
          <div className="empty">This folder is empty.</div>
        ) : (
          // A CSS grid (not a <table>) so the header and every row share one
          // column template — alignment is guaranteed regardless of content.
          <div className="file-table" role="table">
            <div className="file-table__head" role="row">
              <span role="columnheader">Name</span>
              <span role="columnheader">Type</span>
              <span className="file-table__num" role="columnheader">
                Size
              </span>
              <span role="columnheader">Modified</span>
            </div>
            {query.data!.entries.map((entry) => (
              <FileRow
                key={entry.relative_path}
                entry={entry}
                selected={entry.relative_path === selectedPath}
                onOpen={() => onNavigate(entry.relative_path)}
                onSelect={() => onSelectEntry(entry)}
                onOpenFile={() => openFile(entry)}
              />
            ))}
          </div>
        )}
      </div>

      {openIndex !== null && rootId !== null && (
        <FileEntryViewer
          rootId={rootId}
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
  onOpen,
  onSelect,
  onOpenFile,
}: {
  entry: FileViewEntry
  selected: boolean
  onOpen: () => void
  onSelect: () => void
  onOpenFile: () => void
}) {
  const isDir = entry.kind === 'directory'
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      onClick={() => (isDir ? onOpen() : onSelect())}
      onDoubleClick={() => (isDir ? onOpen() : entry.supported && onOpenFile())}
      role="row"
      aria-selected={selected}
    >
      <span className="file-row__name">
        <span className="file-row__icon">{entryIcon(entry)}</span>
        <span className="file-row__text">{entry.name}</span>
        {!isDir && entry.supported && <span className="badge badge--ok">openable</span>}
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {entry.linked && <span className="badge badge--link">linked</span>}
      </span>
      <span className="file-row__type">{isDir ? 'Folder' : (entry.extension ?? 'file')}</span>
      <span className="file-table__num">{isDir ? '' : formatBytes(entry.size_bytes)}</span>
      <span className="file-row__modified">
        {entry.modified_at ? formatDate(entry.modified_at) : ''}
      </span>
    </div>
  )
}
