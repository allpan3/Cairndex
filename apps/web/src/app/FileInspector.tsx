import { useState } from 'react'

import type { FileBrowserEntry } from '../api/client'
import { formatBytes, formatDateTime } from '../lib/format'
import type { HostLabels } from '../platform'
import { fileDragProps } from './dragOut'

/** Tri-state bundle membership shown in the File inspector / Files surface. */
function bundleStatus(entry: FileBrowserEntry): string {
  if (entry.kind === 'directory') return '—'
  if (!entry.linked) return 'Unlinked'
  return entry.unbundled ? 'Unbundled (awaiting bundling)' : 'In a bundle'
}

/**
 * Right-pane details for a File Browser selection. Deliberately *not* the bundle
 * inspector: a filesystem entry is a path, not a bundle, so this shows only
 * file/path facts plus its bundle status.
 *
 * When `onRename` is supplied (write mode on, browse scope), the title is
 * double-click-to-rename, mirroring the bundle inspector's editable title — but
 * a file's "name" is its filename, so committing runs the rename file operation.
 */
export function FileInspector({
  entry,
  hostLabels,
  onRevealFile,
  onOpenFile,
  onStartFileDrag,
  onRename,
}: {
  entry: FileBrowserEntry | null
  hostLabels: HostLabels
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Drag this file out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
  // Rename this entry; undefined leaves the title read-only (no write mode).
  onRename?: (relativePath: string, newName: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  // Abandon any in-progress edit when the selection changes underneath it —
  // adjusted during render (React's pattern for resetting state on a prop
  // change) rather than in an effect, which would flash the stale editor first.
  const relativePath = entry?.relative_path ?? null
  const [lastPath, setLastPath] = useState(relativePath)
  if (relativePath !== lastPath) {
    setLastPath(relativePath)
    setEditing(false)
  }

  if (entry === null) {
    return (
      <aside className="inspector">
        <div className="inspector__empty">Select a file to see its details.</div>
      </aside>
    )
  }

  // No "Name" row: the title above already is the name. No "Path" either — it is
  // the longest value here and wraps to several lines for a nested file, pushing
  // everything else out of view for something that is rarely *read*. It is copied
  // instead, from the row's own context menu.
  const rows: [string, string][] = [
    ['Type', entry.kind === 'directory' ? 'Folder' : (entry.extension ?? 'file')],
    ['Size', entry.kind === 'directory' ? '—' : formatBytes(entry.size_bytes)],
    ['Date Added', entry.created_at ? formatDateTime(entry.created_at) : '—'],
    ['Date Modified', entry.modified_at ? formatDateTime(entry.modified_at) : '—'],
    ['MIME', entry.mime_type ?? '—'],
    ['Media kind', entry.media_kind ?? '—'],
    ['Openable', entry.kind === 'directory' ? '—' : entry.supported ? 'Yes' : 'No'],
    ['Status', bundleStatus(entry)],
  ]

  // Only real files can be dragged out; directories are not draggable.
  const drag = fileDragProps(entry.kind === 'file' ? onStartFileDrag : undefined, () => [
    entry.relative_path,
  ])

  const canRename = onRename !== undefined
  const startEditing = () => {
    if (!canRename) return
    setDraft(entry.name)
    setEditing(true)
  }
  const commit = () => {
    setEditing(false)
    const name = draft.trim()
    if (name && name !== entry.name) onRename?.(entry.relative_path, name)
  }

  return (
    <aside className="inspector">
      {editing ? (
        <input
          className="edit inspector__title-edit"
          value={draft}
          aria-label={`Rename ${entry.name}`}
          autoFocus
          spellCheck={false}
          onFocus={(event) => {
            // Select the stem, not the extension — renaming rarely retypes the type.
            const dot = draft.lastIndexOf('.')
            event.target.setSelectionRange(0, dot > 0 ? dot : draft.length)
          }}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setEditing(false)
            }
          }}
        />
      ) : (
        <div
          className="inspector__title"
          {...drag}
          title={
            canRename
              ? 'Double-click to rename'
              : drag.draggable
                ? 'Drag to copy this file out'
                : undefined
          }
          onDoubleClick={canRename ? startEditing : undefined}
        >
          {entry.name}
        </div>
      )}
      <dl className="file-meta">
        {rows.map(([k, v]) => (
          <div className="file-meta__row" key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {/* Host actions below the facts: the metadata is what the pane is *for*,
          and buttons above it pushed every fact down a row. */}
      {entry.kind === 'file' && (onRevealFile || onOpenFile) && (
        <div className="file-inspector__actions">
          {onOpenFile && (
            <button className="btn" onClick={() => onOpenFile(entry.relative_path)}>
              {hostLabels.openFile}
            </button>
          )}
          {onRevealFile && (
            <button className="btn" onClick={() => onRevealFile(entry.relative_path)}>
              {hostLabels.revealFile}
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
