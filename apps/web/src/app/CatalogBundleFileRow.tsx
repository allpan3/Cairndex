import type { components } from '../api/schema'
import type { LibraryHostFiles } from '../desktop/useLibraryHostFiles'
import { formatBytes, formatDuration, formatFileRole, formatResolution } from '../lib/format'
import { fileDragProps } from './dragOut'
import { IconPlay } from './icons'

export function CatalogBundleFileRow({
  file,
  selected,
  blocked,
  busy,
  cover,
  cut,
  hostFiles,
  onPick,
  onCover,
  onOpen,
}: {
  file: components['schemas']['FileRead']
  selected: boolean
  blocked: boolean
  busy: boolean
  cover: string | null
  cut: number
  hostFiles?: LibraryHostFiles
  onPick: () => void
  onCover: () => void
  onOpen: () => void
}) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const line = [
    formatFileRole(file.media_kind, file.original_filename),
    file.size_bytes ? formatBytes(file.size_bytes) : null,
    meta.width && meta.height
      ? formatResolution(meta.width as number, meta.height as number)
      : null,
    meta.duration ? formatDuration(meta.duration as number) : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const visual = file.media_kind === 'image' || file.media_kind === 'video'
  const isCover = cover === file.id
  return (
    <>
      <button
        className="file-row__main"
        aria-pressed={selected}
        title={file.relative_path}
        onClick={onPick}
        {...fileDragProps(hostFiles?.onStartFileDrag, () => [file.relative_path])}
      >
        <span className="file-row__name">
          {cut > 0 ? (
            <span className="file-row__title file-row__title--split">
              <span className="fname__shared">{file.display_title.slice(0, cut)}</span>
              <span className="fname__distinct">{file.display_title.slice(cut)}</span>
            </span>
          ) : (
            <span className="file-row__title">{file.display_title}</span>
          )}
        </span>
        <span className="file-row__role">{line}</span>
      </button>
      <div className="file-row__actions">
        {visual && (
          <button
            className={`tip cover-action${isCover ? ' cover-action--active' : ''}`}
            data-tip={isCover ? 'Current cover · click to use the automatic cover' : 'Set as cover'}
            aria-label={`Set ${file.relative_path} as cover`}
            aria-pressed={isCover}
            disabled={blocked || busy}
            onClick={onCover}
          >
            ★
          </button>
        )}
        {visual && (
          <button
            className="tip play-file-action"
            data-tip="Play this media"
            aria-label={`Play ${file.relative_path}`}
            onClick={onOpen}
          >
            <IconPlay />
          </button>
        )}
      </div>
    </>
  )
}
