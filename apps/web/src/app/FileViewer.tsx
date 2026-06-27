import { useCallback, useEffect, useState } from 'react'

import { type FileRead, fileContentUrl, fileStreamUrl } from '../api/client'
import { formatBytes, formatDimensions, formatDuration } from '../lib/format'

/**
 * Fullscreen single-file viewer ("lightbox"). Shows a full-resolution image,
 * an inline player for video, or an info card for anything the browser can't
 * render. Arrow keys / on-screen chevrons step through the bundle's files;
 * Escape closes.
 */
export function FileViewer({
  files,
  index,
  onIndex,
  onClose,
}: {
  files: FileRead[]
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
        <span className="viewer__name">{file.display_title}</span>
        <span className="viewer__count">
          {index + 1} / {files.length}
        </span>
      </div>
    </div>
  )
}

function ViewerBody({ file }: { file: FileRead }) {
  // Track image/video load failures so we fall back to the info card instead of
  // a broken-image icon or a silent black box.
  const [failed, setFailed] = useState(false)

  if (file.availability !== 'available') {
    return <InfoCard file={file} message="This file is missing on disk." />
  }
  if (file.media_kind === 'image' && !failed) {
    return (
      <img
        className="viewer__img"
        src={fileContentUrl(file.id)}
        alt={file.display_title}
        onError={() => setFailed(true)}
      />
    )
  }
  if (file.media_kind === 'video' && !failed) {
    return (
      <video
        className="viewer__video"
        src={fileStreamUrl(file.id)}
        controls
        autoPlay
        onError={() => setFailed(true)}
      />
    )
  }
  return (
    <InfoCard
      file={file}
      message={
        failed
          ? "This file can't be shown in the browser."
          : `${file.media_kind} files can't be previewed here.`
      }
    />
  )
}

function InfoCard({ file, message }: { file: FileRead; message: string }) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  return (
    <div className="viewer__info" role="alert">
      <div className="viewer__info-icon">▦</div>
      <strong>{file.display_title}</strong>
      <p>{message}</p>
      <p className="viewer__info-meta">
        {file.role} · {dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}
      </p>
    </div>
  )
}
