import type { FileViewEntry } from '../api/client'
import { formatBytes, formatDateTime } from '../lib/format'

/** Tri-state bundle membership shown in the File inspector / Files surface. */
function bundleStatus(entry: FileViewEntry): string {
  if (entry.kind === 'directory') return '—'
  if (!entry.linked) return 'Unlinked'
  return entry.unbundled ? 'Unbundled (awaiting bundling)' : 'In a bundle'
}

/**
 * Right-pane details for a File View selection. Deliberately *not* the bundle
 * inspector: a filesystem entry is a path, not a bundle, so this shows only
 * file/path facts plus its bundle status.
 */
export function FileInspector({ entry }: { entry: FileViewEntry | null }) {
  if (entry === null) {
    return (
      <aside className="inspector">
        <div className="inspector__empty">Select a file to see its details.</div>
      </aside>
    )
  }

  const rows: [string, string][] = [
    ['Name', entry.name],
    ['Path', entry.relative_path],
    ['Type', entry.kind === 'directory' ? 'Folder' : (entry.extension ?? 'file')],
    ['Size', entry.kind === 'directory' ? '—' : formatBytes(entry.size_bytes)],
    ['Date Added', entry.created_at ? formatDateTime(entry.created_at) : '—'],
    ['Date Modified', entry.modified_at ? formatDateTime(entry.modified_at) : '—'],
    ['MIME', entry.mime_type ?? '—'],
    ['Media kind', entry.media_kind ?? '—'],
    ['Openable', entry.kind === 'directory' ? '—' : entry.supported ? 'Yes' : 'No'],
    ['Status', bundleStatus(entry)],
  ]

  return (
    <aside className="inspector">
      <div className="inspector__title">{entry.name}</div>
      <dl className="file-meta">
        {rows.map(([k, v]) => (
          <div className="file-meta__row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </aside>
  )
}
