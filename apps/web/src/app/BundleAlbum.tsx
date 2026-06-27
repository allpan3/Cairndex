import { useEffect, useState } from 'react'

import { type FileRead, fileThumbnailUrl } from '../api/client'
import { useBundle, useBundleFiles } from '../api/hooks'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'
import { FileViewer } from './FileViewer'

/**
 * Inline "album" view: replaces the bundle grid in the center pane with the
 * files inside one opened bundle. Each file is a thumbnail tile; clicking one
 * opens the fullscreen FileViewer. A back breadcrumb returns to the library.
 */
export function BundleAlbum({ bundleId, onBack }: { bundleId: string; onBack: () => void }) {
  const { data: bundle } = useBundle(bundleId)
  const { data: files = [], isLoading } = useBundleFiles(bundleId)
  const [viewing, setViewing] = useState<number | null>(null)

  // Esc returns to the library — but only when the fullscreen viewer (which has
  // its own Esc-to-close) isn't open.
  useEffect(() => {
    if (viewing !== null) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewing, onBack])

  const title = bundle?.title ?? 'Untitled'

  return (
    <div className="album">
      <div className="album__bar">
        <button className="album__back" onClick={onBack} aria-label="Back to library">
          ‹ Library
        </button>
        <span className="album__title">{title}</span>
        <span className="album__count">
          {files.length} file{files.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className="album__grid" role="list">
        {isLoading && <div className="state">Loading files…</div>}
        {!isLoading && files.length === 0 && <div className="state">This bundle has no files.</div>}
        {files.map((f, i) => (
          <AlbumTile key={f.id} file={f} onOpen={() => setViewing(i)} />
        ))}
      </div>

      {viewing !== null && (
        <FileViewer
          files={files}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  )
}

function AlbumTile({ file, onOpen }: { file: FileRead; onOpen: () => void }) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const thumbnailable =
    file.availability === 'available' &&
    (file.media_kind === 'image' || file.media_kind === 'video')

  return (
    <button className="album-tile" onClick={onOpen} role="listitem" title={file.display_title}>
      <div
        className="album-tile__thumb"
        style={
          thumbnailable
            ? { backgroundImage: `url(${fileThumbnailUrl(file.bundle_id, file.id)})` }
            : undefined
        }
      >
        {!thumbnailable && <span className="album-tile__placeholder">▦</span>}
        {file.availability !== 'available' && (
          <span className="card__badge card__badge--missing">missing</span>
        )}
        {file.media_kind === 'video' && meta.duration != null && (
          <span className="card__dur">{dur}</span>
        )}
      </div>
      <div className="album-tile__name">{file.display_title}</div>
      <div className="album-tile__sub">
        {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}
      </div>
    </button>
  )
}
