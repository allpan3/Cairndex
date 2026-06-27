import type { FileViewEntry, StorageRootRead } from '../api/client'
import { useFileView } from '../api/hooks'
import { formatBytes, formatDate } from '../lib/format'
import type { FileLocation } from './types'

interface FileViewProps {
  roots: StorageRootRead[]
  location: FileLocation
  selectedPath: string | null
  onChangeRoot: (rootId: string) => void
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

/**
 * Read-only File View: a physical, storage-root-scoped filesystem browser.
 * Distinct from the bundle-first Collection View — the visible items here are
 * real directories and files. No move/rename/delete controls exist.
 */
export function FileView({
  roots,
  location,
  selectedPath,
  onChangeRoot,
  onNavigate,
  onSelectEntry,
  onManageLibraries,
}: FileViewProps) {
  const { rootId, path } = location
  const query = useFileView(rootId, path)
  const activeRoot = roots.find((r) => r.id === rootId) ?? null
  const unavailable = activeRoot?.status === 'unavailable'

  return (
    <div className="file-view">
      <div className="file-view__bar">
        <select
          className="edit file-view__root"
          value={rootId ?? ''}
          onChange={(e) => onChangeRoot(e.target.value)}
          aria-label="Library"
        >
          {roots.length === 0 && <option value="">No libraries</option>}
          {roots.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <button className="add-btn" onClick={onManageLibraries}>
          + Library
        </button>
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
          <table className="file-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th className="file-table__num">Size</th>
                <th>Modified</th>
              </tr>
            </thead>
            <tbody>
              {query.data!.entries.map((entry) => (
                <FileRow
                  key={entry.relative_path}
                  entry={entry}
                  selected={entry.relative_path === selectedPath}
                  onOpen={() => onNavigate(entry.relative_path)}
                  onSelect={() => onSelectEntry(entry)}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function FileRow({
  entry,
  selected,
  onOpen,
  onSelect,
}: {
  entry: FileViewEntry
  selected: boolean
  onOpen: () => void
  onSelect: () => void
}) {
  const isDir = entry.kind === 'directory'
  return (
    <tr
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      onClick={() => (isDir ? onOpen() : onSelect())}
      onDoubleClick={() => isDir && onOpen()}
      role="row"
      aria-selected={selected}
    >
      <td className="file-row__name">
        <span className="file-row__icon">{isDir ? '🗀' : entry.supported ? '🎬' : '📄'}</span>
        <span>{entry.name}</span>
        {!isDir && entry.supported && <span className="badge badge--ok">openable</span>}
        {!isDir && !entry.supported && <span className="badge">unsupported</span>}
        {entry.linked && <span className="badge badge--link">linked</span>}
      </td>
      <td className="file-row__type">{isDir ? 'Folder' : (entry.extension ?? 'file')}</td>
      <td className="file-table__num">{isDir ? '' : formatBytes(entry.size_bytes)}</td>
      <td>{entry.modified_at ? formatDate(entry.modified_at) : ''}</td>
    </tr>
  )
}
