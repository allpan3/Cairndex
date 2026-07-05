import { useCallback, useEffect, useState } from 'react'

import { type FileViewEntry, fileViewContentUrl } from '../api/client'
import { formatBytes } from '../lib/format'

/**
 * Fullscreen lightbox for the read-only File View. This previews a physical
 * filesystem entry by its library-relative path — files here need not be linked
 * into any bundle. Images and video render inline; anything the browser can't
 * show falls back to an info card. Arrow keys / chevrons step through the
 * supported files in the current folder; Escape closes.
 */
export function FileEntryViewer({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: FileViewEntry[]
  index: number
  onIndex: (i: number) => void
  onClose: () => void
}) {
  const file = files[index]

  const step = useCallback(
    (delta: number) => {
      const next = index + delta
      if (next >= 0 && next < files.length) onIndex(next)
    },
    [index, files.length, onIndex],
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight') step(1)
      else if (e.key === 'ArrowLeft') step(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step, onClose])

  if (!file) return null

  return (
    <div className="viewer" onMouseDown={onClose} role="dialog" aria-modal="true">
      <button className="viewer__close" onClick={onClose} aria-label="Close">
        ×
      </button>
      {index > 0 && (
        <button
          className="viewer__nav viewer__nav--prev"
          onMouseDown={(e) => {
            e.stopPropagation()
            step(-1)
          }}
          aria-label="Previous file"
        >
          ‹
        </button>
      )}
      {index < files.length - 1 && (
        <button
          className="viewer__nav viewer__nav--next"
          onMouseDown={(e) => {
            e.stopPropagation()
            step(1)
          }}
          aria-label="Next file"
        >
          ›
        </button>
      )}

      <div className="viewer__stage" onMouseDown={(e) => e.stopPropagation()}>
        <ViewerBody file={file} />
      </div>

      <div className="viewer__caption" onMouseDown={(e) => e.stopPropagation()}>
        <span className="viewer__name">{file.name}</span>
        <span className="viewer__count">
          {index + 1} / {files.length}
        </span>
      </div>
    </div>
  )
}

function ViewerBody({ file }: { file: FileViewEntry }) {
  const [failed, setFailed] = useState(false)
  const src = fileViewContentUrl(file.relative_path)

  if (file.media_kind === 'image' && !failed) {
    return <img className="viewer__img" src={src} alt={file.name} onError={() => setFailed(true)} />
  }
  if (file.media_kind === 'video' && !failed) {
    return (
      <video
        className="viewer__video"
        src={src}
        controls
        autoPlay
        onError={() => setFailed(true)}
      />
    )
  }
  if (file.media_kind === 'audio' && !failed) {
    return (
      <audio
        className="viewer__audio"
        src={src}
        controls
        autoPlay
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <div className="viewer__info" role="alert">
      <div className="viewer__info-icon">▦</div>
      <strong>{file.name}</strong>
      <p>
        {failed
          ? "This file can't be shown in the browser."
          : `${file.media_kind ?? 'This'} files can't be previewed here.`}
      </p>
      <p className="viewer__info-meta">
        {(file.extension ?? 'file').toUpperCase()} · {formatBytes(file.size_bytes)}
      </p>
    </div>
  )
}
