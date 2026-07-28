import { useMemo, useState } from 'react'

import type { BundleSummary } from '../api/client'
import { fileThumbnailUrl, thumbnailUrl } from '../api/client'
import { formatDimensions, formatDuration } from '../lib/format'
import { HoverPreview } from './HoverPreview'
import { markHtmlFileDropHandled } from './htmlFileDrop'
import type { HoverPreviewSource } from './hoverPreviewState'

interface BundleCardProps {
  item: BundleSummary
  selected: boolean
  showMeta: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  previewDisabled?: boolean
  /**
   * OS files dropped onto this card: import them into the library and link them
   * into this bundle. Absent when the library cannot be written (the drop then
   * falls through to the window net's guidance rather than half-working).
   */
  onDropFiles?: (id: string, files: File[]) => void
}

export function BundleCard({
  item,
  selected,
  showMeta,
  onSelect,
  onOpen,
  onContextMenu,
  previewDisabled = false,
  onDropFiles,
}: BundleCardProps) {
  const [fileDropOver, setFileDropOver] = useState(false)
  // Duration only makes sense for a video-backed card; an image bundle whose
  // current file happens to carry a stray "duration" in its metadata shouldn't
  // show a runtime badge next to a JPG type badge.
  const isVideo = item.media_kind === 'video'
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      item.resume_file_id && item.resume_media_kind === 'image'
        ? {
            mediaKind: 'image',
            fileId: item.resume_file_id,
            imageUrl: fileThumbnailUrl(
              item.id,
              item.resume_file_id,
              item.resume_file_updated_at ?? undefined,
            ),
          }
        : item.resume_file_id && item.resume_media_kind === 'video' && item.resume_duration
          ? {
              mediaKind: 'video',
              fileId: item.resume_file_id,
              mimeType: item.resume_mime_type,
              relativePath: item.resume_relative_path,
              container: item.resume_container,
              videoCodec: item.resume_video_codec,
              videoCodecTag: item.resume_video_codec_tag,
              audioCodec: item.resume_audio_codec,
              duration: item.resume_duration,
              startTime: item.resume_position,
            }
          : null,
    [
      item.id,
      item.resume_audio_codec,
      item.resume_container,
      item.resume_video_codec_tag,
      item.resume_duration,
      item.resume_file_id,
      item.resume_file_updated_at,
      item.resume_media_kind,
      item.resume_mime_type,
      item.resume_position,
      item.resume_relative_path,
      item.resume_video_codec,
    ],
  )
  return (
    <div
      className={`card${selected ? ' card--selected' : ''}${fileDropOver ? ' card--file-drop' : ''}`}
      // Selection happens on press, not release. A drag that begins on an
      // unselected card swallows the click that would have selected it, so the
      // card departed unselected — and the drag then carried whatever the *old*
      // selection was. Pressing an already-selected card changes nothing here
      // (the group must survive so it can be dragged together); the plain click
      // on release still collapses to just this card, as before. Modifier
      // presses stay on click, where range/toggle logic already lives.
      onMouseDown={(e) => {
        if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey || selected) return
        onSelect(item.id, e)
      }}
      onClick={(e) => onSelect(item.id, e)}
      onDoubleClick={() => onOpen(item.id)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      // An OS file dropped on a card lands *in this bundle* (import + link).
      // Internal card drags carry custom types, never Files, so reorder is
      // untouched; without a handler the webview's default was to navigate to
      // the dropped file (owner report, 2026-07-27).
      onDragOver={
        onDropFiles
          ? (e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'copy'
              setFileDropOver(true)
            }
          : undefined
      }
      onDragLeave={onDropFiles ? () => setFileDropOver(false) : undefined}
      onDrop={
        onDropFiles
          ? (e) => {
              if (!e.dataTransfer.types.includes('Files')) return
              e.preventDefault()
              markHtmlFileDropHandled()
              setFileDropOver(false)
              onDropFiles(item.id, [...e.dataTransfer.files])
            }
          : undefined
      }
      role="option"
      aria-selected={selected}
      data-bundle-id={item.id}
      data-file-drop={fileDropOver || undefined}
    >
      <HoverPreview
        source={previewSource}
        disabled={previewDisabled}
        className="card__thumb"
        style={
          item.has_cover
            ? { backgroundImage: `url(${thumbnailUrl(item.id, item.cover_key)})` }
            : undefined
        }
      >
        {!item.has_cover && <div className="card__placeholder">▦</div>}
        {item.has_missing && <span className="card__badge card__badge--missing">missing</span>}
        {!item.has_missing && item.grouping_state === 'provisional' && (
          <span className="card__badge card__badge--review">review</span>
        )}
        {!item.has_missing && item.grouping_state !== 'provisional' && item.extension && (
          <span className="card__badge">{item.extension}</span>
        )}
        {item.file_count > 1 && (
          <span className="card__badge" style={{ left: 'auto', right: 6 }}>
            {item.file_count}
          </span>
        )}
        {isVideo && item.duration ? (
          <span className="card__dur">{formatDuration(item.duration)}</span>
        ) : null}
      </HoverPreview>
      {showMeta && (
        <div className="card__meta">
          <div className="card__title">{item.title ?? 'Untitled'}</div>
          <div className="card__sub">
            <span>
              {isVideo && item.duration
                ? formatDuration(item.duration)
                : formatDimensions(item.width, item.height)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
