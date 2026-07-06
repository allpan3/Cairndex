import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { type FileRead, type PlayableVideo, thumbnailUrl } from '../../api/client'
import { useBundle, useBundleFiles, usePlaybackManifest } from '../../api/hooks'
import { formatBytes, formatDimensions, formatDuration } from '../../lib/format'
import type { PlayerPrefs } from '../types'
import { ImageStage } from './ImageStage'
import { MediaFallback } from './MediaFallback'
import { VideoStage } from './VideoStage'
import { ControlBar } from './player/ControlBar'
import { useIdleHide } from './player/useIdleHide'
import { usePlayer } from './player/usePlayer'
import { useShortcuts } from './player/useShortcuts'

interface MediaViewerProps {
  bundleId: string
  initialFileId?: string | null
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onClose: () => void
}

/** Unified bundle media lightbox for direct-play M2 video and simple images. */
export function MediaViewer({
  bundleId,
  initialFileId,
  playerPrefs,
  onPlayerPrefs,
  onClose,
}: MediaViewerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { data: bundle, isLoading: bundleLoading, error: bundleError } = useBundle(bundleId)
  const { data: files = [], isLoading: filesLoading, error: filesError } = useBundleFiles(bundleId)
  const {
    data: manifest,
    isLoading: playbackLoading,
    error: playbackError,
  } = usePlaybackManifest(bundleId)
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [failedFileId, setFailedFileId] = useState<string | null>(null)

  const preferredId =
    (initialFileId && files.some((file) => file.id === initialFileId) ? initialFileId : null) ??
    (bundle?.primary_file_id && files.some((file) => file.id === bundle.primary_file_id)
      ? bundle.primary_file_id
      : null) ??
    files.find((file) => file.media_kind === 'video')?.id ??
    files[0]?.id ??
    null
  const selectedId = pickedId && files.some((file) => file.id === pickedId) ? pickedId : preferredId
  const currentIndex = selectedId ? files.findIndex((file) => file.id === selectedId) : -1
  const current = currentIndex >= 0 ? files[currentIndex] : null
  const failed = current ? failedFileId === current.id : false
  const playable = useMemo(
    () => manifest?.videos.find((video) => video.file_id === current?.id) ?? null,
    [current?.id, manifest?.videos],
  )
  const source = useMemo(
    () => (playable?.playable ? { src: playable.stream_url, mimeType: playable.mime_type } : null),
    [playable],
  )
  const { player, videoRef, videoElement } = usePlayer({
    source,
    rootRef,
    prefs: playerPrefs,
    onPrefs: onPlayerPrefs,
  })
  const chromeIdle = useIdleHide(rootRef)
  const title = bundle?.title ?? current?.display_title ?? 'Media'
  const artworkUrl = thumbnailUrl(bundleId, bundle?.cover_file_id ?? null)

  useEffect(() => rootRef.current?.focus(), [])

  const toggleInfo = useCallback(() => setInfoOpen((v) => !v), [])

  const step = useCallback(
    (delta: number) => {
      if (currentIndex < 0) return
      const next = currentIndex + delta
      if (next >= 0 && next < files.length) setPickedId(files[next]?.id ?? null)
    },
    [currentIndex, files],
  )

  const snapshot = useCallback(() => {
    const video = videoElement
    if (!video) return
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, video.videoWidth || 1280)
    canvas.height = Math.max(1, video.videoHeight || 720)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    } catch {
      ctx.fillStyle = '#050609'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
    }
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${safeName(current?.display_title ?? title)}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [current?.display_title, title, videoElement])

  useShortcuts(rootRef, playable?.playable ? player : null, {
    close: onClose,
    toggleInfo,
    snapshot,
    previous: () => step(-1),
    next: () => step(1),
  })

  const loading =
    bundleLoading || filesLoading || (current?.media_kind === 'video' && playbackLoading)
  const error =
    bundleError ?? filesError ?? (current?.media_kind === 'video' ? playbackError : null)

  return (
    <div
      className={`media-viewer${chromeIdle ? ' media-viewer--idle' : ''}`}
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      tabIndex={-1}
    >
      <Topbar
        title={title}
        subtitle={
          current ? `${current.display_title} · ${currentIndex + 1} / ${files.length}` : 'Media'
        }
        infoOpen={infoOpen}
        onToggleInfo={toggleInfo}
        onClose={onClose}
      />

      <button
        className="mv-nav mv-nav--prev"
        onClick={() => step(-1)}
        aria-label="Previous file"
        disabled={currentIndex <= 0}
      >
        ‹
      </button>
      <button
        className="mv-nav mv-nav--next"
        onClick={() => step(1)}
        aria-label="Next file"
        disabled={currentIndex < 0 || currentIndex >= files.length - 1}
      >
        ›
      </button>

      <div className="mv-stage">
        {loading && <div className="mv-state">Loading media…</div>}
        {!loading && error && (
          <div className="mv-state mv-state--error">
            <strong>Couldn’t load this bundle.</strong>
            <code>{error instanceof Error ? error.message : 'Unknown error'}</code>
          </div>
        )}
        {!loading && !error && files.length === 0 && (
          <div className="mv-state">This bundle has no files.</div>
        )}
        {!loading && !error && current && (
          <Stage
            file={current}
            playable={playable}
            player={player}
            videoRef={videoRef}
            title={title}
            artworkUrl={artworkUrl}
            failed={failed}
            onError={() => {
              if (current) setFailedFileId(current.id)
            }}
          />
        )}
      </div>

      {playable?.playable && (
        <ControlBar
          player={player}
          video={playable}
          subtitles={playable.subtitles}
          onSnapshot={snapshot}
        />
      )}

      {infoOpen && current && <InfoPanel file={current} playable={playable} />}
    </div>
  )
}

/** Render the current file's stage or a structured fallback card. */
function Stage({
  file,
  playable,
  player,
  videoRef,
  title,
  artworkUrl,
  failed,
  onError,
}: {
  file: FileRead
  playable: PlayableVideo | null
  player: ReturnType<typeof usePlayer>['player']
  videoRef: (element: HTMLVideoElement | null) => void
  title: string
  artworkUrl: string
  failed: boolean
  onError: () => void
}) {
  if (file.availability !== 'available') {
    return <FallbackCard file={file} message="This file is missing on disk." />
  }
  if (file.media_kind === 'image' && !failed) {
    return <ImageStage file={file} onError={onError} />
  }
  if (file.media_kind === 'video' && playable?.playable && !failed) {
    return (
      <VideoStage
        video={playable}
        player={player}
        videoRef={videoRef}
        title={title}
        artworkUrl={artworkUrl}
        onError={onError}
      />
    )
  }
  if (file.media_kind === 'video' && playable && !playable.playable) {
    return (
      <FallbackCard
        file={file}
        message={playable.reason}
        heading="Can’t play this in the browser."
      />
    )
  }
  return (
    <FallbackCard
      file={file}
      heading={failed ? 'Preview failed.' : undefined}
      message={
        failed
          ? "This file can't be shown in the browser."
          : `${file.media_kind} files can't be previewed here.`
      }
    />
  )
}

const Topbar = memo(function Topbar({
  title,
  subtitle,
  infoOpen,
  onToggleInfo,
  onClose,
}: {
  title: string
  subtitle: string
  infoOpen: boolean
  onToggleInfo: () => void
  onClose: () => void
}) {
  return (
    <div className="mv-topbar">
      <div>
        <div className="mv-title">{title}</div>
        <div className="mv-subtitle">{subtitle}</div>
      </div>
      <div className="mv-topbar__actions">
        <button
          className={`mv-icon${infoOpen ? ' is-active' : ''}`}
          onClick={onToggleInfo}
          aria-label="Info"
          title="Info"
        >
          i
        </button>
        <button className="mv-icon" onClick={onClose} aria-label="Close" title="Close">
          ×
        </button>
      </div>
    </div>
  )
})

/** Metadata side panel for the selected file. */
function InfoPanel({ file, playable }: { file: FileRead; playable: PlayableVideo | null }) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const subtitles = playable?.subtitles.filter((track) => track.src).map((track) => track.label)
  return (
    <aside className="mv-info">
      <h3>{file.display_title}</h3>
      <dl>
        <div>
          <dt>Kind</dt>
          <dd>{file.media_kind}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{file.role}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(file.size_bytes)}</dd>
        </div>
        <div>
          <dt>Dimensions</dt>
          <dd>{dims}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{dur}</dd>
        </div>
        <div>
          <dt>Subtitles</dt>
          <dd>{subtitles && subtitles.length > 0 ? subtitles.join(', ') : '—'}</dd>
        </div>
      </dl>
    </aside>
  )
}

/** Structured fallback for missing, unsupported, or failed files. */
function FallbackCard({
  file,
  message,
  heading = file.display_title,
}: {
  file: FileRead
  message: string
  heading?: string
}) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const metaText = `${file.role} · ${dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}`
  return <MediaFallback heading={heading} message={message} meta={metaText} />
}

/** Filesystem-safe-ish basename for downloaded PNG snapshots. */
function safeName(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\w.-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'snapshot'
  )
}
