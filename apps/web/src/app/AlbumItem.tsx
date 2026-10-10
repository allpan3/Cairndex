import { useMemo, useState } from 'react'
import { type FileRead, fileThumbnailUrl } from '../api/client'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'
import type { FileDragProps } from './dragOut'
import { HoverPreview } from './HoverPreview'
import type { HoverPreviewSource } from './hoverPreviewState'
import { factsFromBundleFile } from './fileFacts'

export function AlbumTile({
  file,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  previewDisabled,
  dragProps,
  catalog = false,
}: {
  file: FileRead
  selected: boolean
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  previewDisabled: boolean
  dragProps: FileDragProps
  catalog?: boolean
}) {
  const [failedPreview, setFailedPreview] = useState('')
  const previewUrl = fileThumbnailUrl(file.bundle_id, file.id, file.updated_at)
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const thumbnailable =
    (catalog || file.availability === 'available') &&
    (file.media_kind === 'image' || file.media_kind === 'video')
  const duration = typeof meta.duration === 'number' ? meta.duration : 0
  const container = typeof meta.container === 'string' ? meta.container : null
  const videoCodec = typeof meta.video_codec === 'string' ? meta.video_codec : null
  const audioCodec = typeof meta.audio_codec === 'string' ? meta.audio_codec : null
  const previewSource = useMemo<HoverPreviewSource | null>(
    () =>
      file.availability === 'available' && file.media_kind === 'video' && duration > 0
        ? {
            mediaKind: 'video',
            fileId: file.id,
            mimeType: file.mime_type,
            relativePath: file.relative_path,
            container,
            videoCodec,
            audioCodec,
            duration,
            startTime: file.resume_position,
          }
        : null,
    [
      audioCodec,
      container,
      duration,
      file.availability,
      file.id,
      file.media_kind,
      file.mime_type,
      file.relative_path,
      file.resume_position,
      videoCodec,
    ],
  )

  return (
    <div
      className={`album-tile${selected ? ' album-tile--selected' : ''}`}
      onClick={(event) => onSelect(event)}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (event.key === 'Enter' && catalog) onOpen()
        else onSelect(event)
      }}
      role="button"
      aria-pressed={selected}
      tabIndex={0}
      title={file.display_title}
      data-file-id={file.id}
      {...dragProps}
    >
      <HoverPreview
        source={previewSource}
        disabled={previewDisabled}
        className="album-tile__thumb"
        style={
          thumbnailable && !catalog
            ? {
                backgroundImage: `url(${fileThumbnailUrl(file.bundle_id, file.id, file.updated_at)})`,
              }
            : undefined
        }
      >
        {catalog &&
          thumbnailable &&
          (failedPreview === previewUrl ? (
            <span>Preview unavailable</span>
          ) : (
            <img
              src={previewUrl}
              alt=""
              loading="lazy"
              style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute' }}
              onError={() => setFailedPreview(previewUrl)}
            />
          ))}
        {!thumbnailable && <span className="album-tile__placeholder">▦</span>}
        {!catalog && file.availability !== 'available' && (
          <span className="card__badge card__badge--missing">missing</span>
        )}
        {file.media_kind === 'video' && meta.duration != null && (
          <span className="card__dur">{dur}</span>
        )}
      </HoverPreview>
      <div className="album-tile__name">{file.display_title}</div>
      <div className="album-tile__sub">
        {catalog
          ? 'Check local bytes when opened'
          : dims !== '—'
            ? dims
            : dur !== '—'
              ? dur
              : formatBytes(file.size_bytes)}
      </div>
    </div>
  )
}

/** One file as a row, matching the File Browser's list layout. */
export function AlbumRow({
  file,
  selected,
  onSelect,
  onOpen,
  onContextMenu,
  dragProps,
  catalog = false,
}: {
  file: FileRead
  selected: boolean
  onSelect: (e: React.MouseEvent | React.KeyboardEvent) => void
  onOpen: () => void
  onContextMenu: (e: React.MouseEvent) => void
  dragProps: FileDragProps
  catalog?: boolean
}) {
  const facts = factsFromBundleFile(file)
  return (
    <div
      className={`file-row${selected ? ' file-row--selected' : ''}`}
      data-file-id={file.id}
      role="row"
      aria-selected={selected}
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        if (event.key === 'Enter' && catalog) onOpen()
        else onSelect(event)
      }}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onContextMenu={onContextMenu}
      {...dragProps}
    >
      <span className="file-row__name">
        <span className="file-row__icon">
          <span className="file-row__thumb-holder">
            {file.media_kind === 'image' || file.media_kind === 'video' ? (
              <img
                className="file-row__thumb"
                src={fileThumbnailUrl(file.bundle_id, file.id, file.updated_at)}
                alt=""
                loading="lazy"
              />
            ) : (
              <span aria-hidden="true">📄</span>
            )}
          </span>
        </span>
        <span className="file-row__text">{file.display_title}</span>
        {!file.supported && <span className="badge">unsupported</span>}
        {!catalog && file.availability !== 'available' && (
          <span className="badge badge--warn">missing</span>
        )}
      </span>
      <span className="file-row__type">{facts.extension ?? 'file'}</span>
      <span className="file-table__num">{formatBytes(file.size_bytes)}</span>
      <span className="file-row__added">
        {facts.duration ? formatDuration(facts.duration) : ''}
      </span>
      <span className="file-row__modified">{formatDimensions(facts.width, facts.height)}</span>
    </div>
  )
}
