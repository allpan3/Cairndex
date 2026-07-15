import { useMemo } from 'react'

import type { BundleSummary } from '../api/client'
import { fileThumbnailUrl, thumbnailUrl } from '../api/client'
import { formatDimensions, formatDuration } from '../lib/format'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'

interface BundleCardProps {
  item: BundleSummary
  selected: boolean
  showMeta: boolean
  onSelect: (id: string, e: React.MouseEvent) => void
  onOpen: (id: string) => void
  onContextMenu: (id: string, e: React.MouseEvent) => void
  previewDisabled?: boolean
}

export function BundleCard({
  item,
  selected,
  showMeta,
  onSelect,
  onOpen,
  onContextMenu,
  previewDisabled = false,
}: BundleCardProps) {
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
              audioCodec: item.resume_audio_codec,
              duration: item.resume_duration,
              startTime: item.resume_position,
            }
          : null,
    [
      item.id,
      item.resume_audio_codec,
      item.resume_container,
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
      className={`card${selected ? ' card--selected' : ''}`}
      onClick={(e) => onSelect(item.id, e)}
      onDoubleClick={() => onOpen(item.id)}
      onContextMenu={(e) => onContextMenu(item.id, e)}
      role="option"
      aria-selected={selected}
      data-bundle-id={item.id}
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
