import { useState } from 'react'

import {
  formatBitrate,
  formatBytes,
  formatCodec,
  formatDateTime,
  formatDimensions,
  formatDuration,
  formatFileType,
  formatVideoEncoding,
} from '../lib/format'
import type { HostLabels } from '../platform'
import { fileDragProps } from './dragOut'
import type { FileFacts } from './fileFacts'
import { NameEditor } from './FileWriteDialogs'
import { renameError } from './sourceActions'
import { OverlayScrollbar } from './OverlayScrollbar'

/**
 * Right-pane details for one file, wherever it was selected. Deliberately *not*
 * the bundle inspector: this describes a file, not the bundle around it.
 *
 * It takes normalized `FileFacts` rather than either source type, so the File
 * Browser and the in-bundle view drive the same pane instead of each growing
 * their own (owner, 2026-07-27).
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
  locateLabel,
  onLocate,
  locateDisabled = false,
}: {
  entry: FileFacts | null
  hostLabels: HostLabels
  onRevealFile?: (relativePath: string) => void
  onOpenFile?: (relativePath: string) => void
  // Drag this file out to Finder/other apps (plan 3 §6); undefined disables it.
  onStartFileDrag?: (relativePaths: string[]) => void
  // Rename this entry; undefined leaves the title read-only (no write mode).
  onRename?: (relativePath: string, newName: string) => void | Promise<void>
  // In-app navigation, available in both web and desktop builds.
  locateLabel?: string
  onLocate?: (relativePath: string) => void
  /** Shown but unavailable, for a file that is not in a bundle yet */
  locateDisabled?: boolean
}) {
  const [editing, setEditing] = useState(false)
  // Abandon any in-progress edit when the selection changes underneath it —
  // adjusted during render (React's pattern for resetting state on a prop
  // change) rather than in an effect, which would flash the stale editor first.
  const relativePath = entry?.relativePath ?? null
  const [lastPath, setLastPath] = useState(relativePath)
  if (relativePath !== lastPath) {
    setLastPath(relativePath)
    setEditing(false)
  }

  const canRename = onRename !== undefined
  if (!canRename && editing) setEditing(false)
  const startEditing = () => {
    if (canRename && entry) setEditing(true)
  }

  if (entry === null) {
    return (
      <aside className="inspector" data-tauri-drag-region>
        <div className="inspector__empty">Select a file to see its details.</div>
      </aside>
    )
  }

  // No "Name" row: the title above already is the name. Path *is* here now — in
  // a bundle the files can come from anywhere, so where one lives is the thing
  // you want the pane to tell you (owner, 2026-07-27). It wraps rather than
  // truncates, and sits last so a deep path pushes nothing else out of view.
  const dims = formatDimensions(entry.width, entry.height)
  const rows: [string, string][] = [
    // Same spelling as every other surface's type label, so a file does not
    // read as "mp4" here and "MP4" one pane over.
    [
      'Type',
      entry.kind === 'directory'
        ? 'Folder'
        : formatFileType(entry.mediaKind ?? 'other', entry.name),
    ],
    ['Size', entry.kind === 'directory' ? '—' : formatBytes(entry.sizeBytes)],
    ...(dims !== '—' ? ([['Dimensions', dims]] as [string, string][]) : []),
    ...(entry.duration
      ? ([['Duration', formatDuration(entry.duration)]] as [string, string][])
      : []),
    ...(entry.fps
      ? ([['Frame rate', `${Math.round(entry.fps * 100) / 100} fps`]] as [string, string][])
      : []),
    // Encoding rows appear only once a file has been probed. An un-probed row
    // would otherwise grow three em-dashes that say nothing about the file.
    ...(entry.videoCodec
      ? ([
          [
            'Video',
            formatVideoEncoding(entry.videoCodec, { bitDepth: entry.bitDepth, hdr: entry.hdr }),
          ],
        ] as [string, string][])
      : []),
    ...(entry.audioCodec ? ([['Audio', formatCodec(entry.audioCodec)]] as [string, string][]) : []),
    ...(entry.bitrate ? ([['Bitrate', formatBitrate(entry.bitrate)]] as [string, string][]) : []),
    ['Date Added', entry.createdAt ? formatDateTime(entry.createdAt) : '—'],
    ['Date Modified', entry.modifiedAt ? formatDateTime(entry.modifiedAt) : '—'],
    ['MIME', entry.mimeType ?? '—'],
    ['Media kind', entry.mediaKind ?? '—'],
    ['Openable', entry.kind === 'directory' ? '—' : entry.supported ? 'Yes' : 'No'],
    ['Status', entry.status],
    ['Path', entry.relativePath],
  ]

  // Only real files can be dragged out; directories are not draggable.
  const drag = fileDragProps(entry.kind === 'file' ? onStartFileDrag : undefined, () => [
    entry.relativePath,
  ])

  return (
    <aside className="inspector" data-tauri-drag-region>
      <OverlayScrollbar />
      {editing ? (
        <NameEditor
          key={entry.relativePath}
          className="edit inspector__title-edit"
          initial={entry.name}
          label={`Rename ${entry.name}`}
          validate={renameError}
          onSubmit={(name) => {
            const result =
              name.trim() && name.trim() !== entry.name
                ? onRename?.(entry.relativePath, name.trim())
                : undefined
            if (result) return result.then(() => setEditing(false))
            setEditing(false)
          }}
          onCancel={() => setEditing(false)}
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
      {/* Actions below the facts: the metadata is what the pane is *for*, and
          buttons above it pushed every fact down a row. Locate stays available
          on the web; Open/Reveal remain mapped-desktop capabilities. */}
      {entry.kind === 'file' && (onLocate || onRevealFile || onOpenFile) && (
        <div className="file-inspector__actions">
          {onLocate && (
            <button
              className="btn"
              disabled={locateDisabled}
              title={locateDisabled ? 'This file is not in a bundle yet' : undefined}
              onClick={() => onLocate(entry.relativePath)}
            >
              {locateLabel ?? 'Locate'}
            </button>
          )}
          {onOpenFile && (
            <button className="btn" onClick={() => onOpenFile(entry.relativePath)}>
              {hostLabels.openFile}
            </button>
          )}
          {onRevealFile && (
            <button className="btn" onClick={() => onRevealFile(entry.relativePath)}>
              {hostLabels.revealFile}
            </button>
          )}
        </div>
      )}
    </aside>
  )
}
