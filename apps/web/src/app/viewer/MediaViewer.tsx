import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  type FileRead,
  type PlayableVideo,
  type PlaybackManifest,
  thumbnailUrl,
  updatePlaybackProgress,
} from '../../api/client'
import { useBundle, useBundleFiles, usePlaybackManifest } from '../../api/hooks'
import { formatBytes, formatClock, formatDimensions, formatDuration } from '../../lib/format'
import type { PlayerPrefs } from '../types'
import { ImageStage } from './ImageStage'
import { MediaFallback } from './MediaFallback'
import { VideoStage } from './VideoStage'
import { getClientCapabilities } from './player/caps'
import { ControlBar } from './player/ControlBar'
import { useHlsSession, type HlsSessionState } from './player/useHlsSession'
import { useIdleHide } from './player/useIdleHide'
import { usePlaybackProgressReporter } from './player/usePlaybackProgressReporter'
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
  const qc = useQueryClient()
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
  const [resumeNotice, setResumeNotice] = useState<{ fileId: string; position: number } | null>(
    null,
  )

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
  const currentId = current?.id ?? null
  const playable = useMemo(
    () => manifest?.videos.find((video) => video.file_id === current?.id) ?? null,
    [current?.id, manifest?.videos],
  )
  const isVideo = current?.media_kind === 'video'
  const videoAvailable = current?.availability === 'available'
  // Capability profile is computed once per tab; memo keeps a stable reference
  // so it can be a hook dependency without re-running effects.
  const caps = useMemo(() => getClientCapabilities(), [])
  const liveVideoRef = useRef<HTMLVideoElement | null>(null)
  const getCurrentTime = useCallback(() => liveVideoRef.current?.currentTime ?? 0, [])
  const hls = useHlsSession({
    fileId: isVideo && videoAvailable ? currentId : null,
    enabled: Boolean(isVideo && videoAvailable && playable),
    directPlayable: playable?.playable ?? false,
    directStreamUrl: playable?.stream_url ?? null,
    directMimeType: playable?.mime_type ?? null,
    caps,
    getCurrentTime,
  })
  const source = hls.source
  const resumePosition =
    playable?.progress && playable.progress.position_s > 0 && !playable.progress.completed
      ? playable.progress.position_s
      : null
  const { player, videoRef, videoElement } = usePlayer({
    source,
    rootRef,
    prefs: playerPrefs,
    onPrefs: onPlayerPrefs,
    resumePosition,
    resumeCompleted: playable?.progress?.completed ?? false,
    onResumed: (position) => {
      if (playable) setResumeNotice({ fileId: playable.file_id, position })
    },
  })
  useEffect(() => {
    liveVideoRef.current = videoElement
  }, [videoElement])
  // Refund the HLS re-attach budget once the playhead actually advances — a
  // small forward delta means real playback, whereas the `play` intent event or
  // a re-attach seek must not reset it (else a broken stream re-decides forever).
  const notePlaying = hls.notePlaying
  const lastTimeRef = useRef(0)
  useEffect(() => {
    const delta = player.currentTime - lastTimeRef.current
    lastTimeRef.current = player.currentTime
    if (delta > 0 && delta < 1.5) notePlaying()
  }, [notePlaying, player.currentTime])
  // A video plays once the decision produced a source (native or HLS); this,
  // not the manifest's direct-only `playable` flag, gates the video UI in M7.
  const videoActive = Boolean(isVideo && videoAvailable && source)
  usePlaybackProgressReporter({
    bundleId,
    fileId: playable?.file_id ?? null,
    enabled: videoActive,
    status: player.status,
    currentTime: player.currentTime,
    duration: player.duration || playable?.duration || 0,
    completed: playable?.progress?.completed,
  })
  const chromeIdle = useIdleHide(rootRef)
  const title = bundle?.title ?? current?.display_title ?? 'Media'
  const artworkUrl = thumbnailUrl(bundleId, bundle?.cover_file_id ?? null)

  useEffect(() => rootRef.current?.focus(), [])

  useEffect(() => {
    if (resumeNotice === null) return
    const timer = window.setTimeout(() => setResumeNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [resumeNotice])

  const toggleInfo = useCallback(() => setInfoOpen((v) => !v), [])
  const playableFileId = playable?.file_id ?? null
  const playableDuration = playable?.duration ?? null
  const restartFromBeginning = useCallback(() => {
    player.seek(0)
    setResumeNotice(null)
    if (!playableFileId) return
    const duration =
      Number.isFinite(player.duration) && player.duration > 0 ? player.duration : playableDuration
    void updatePlaybackProgress(playableFileId, {
      position_s: 0,
      duration_s: duration ?? null,
    }).then((progress) => {
      qc.setQueryData<PlaybackManifest>(['playback', bundleId], (previous) =>
        previous
          ? {
              ...previous,
              videos: previous.videos.map((video) =>
                video.file_id === playableFileId ? { ...video, progress } : video,
              ),
            }
          : previous,
      )
      qc.invalidateQueries({ queryKey: ['continue-watching'] })
    })
  }, [bundleId, playableDuration, playableFileId, player, qc])
  const visibleResume =
    resumeNotice && resumeNotice.fileId === playable?.file_id ? resumeNotice.position : null
  const { reattach } = hls
  const handleStageError = useCallback(() => {
    // An HLS session that idled out (long pause) or hit an hls.js fatal error
    // re-attaches transparently at the current playhead; only a non-recoverable
    // source falls through to the "can't play" card.
    if (reattach()) return
    if (currentId) setFailedFileId(currentId)
  }, [currentId, reattach])

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

  useShortcuts(rootRef, videoActive ? player : null, {
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
            videoActive={videoActive}
            hls={hls}
            onError={handleStageError}
          />
        )}
      </div>

      {visibleResume !== null && (
        <button className="mv-resume" type="button" onClick={restartFromBeginning}>
          Resumed at {formatClock(visibleResume)} <span>Click to restart</span>
        </button>
      )}

      {videoActive && playable && (
        <ControlBar
          player={player}
          video={playable}
          subtitles={playable.subtitles}
          hls={hls}
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
  videoActive,
  hls,
  onError,
}: {
  file: FileRead
  playable: PlayableVideo | null
  player: ReturnType<typeof usePlayer>['player']
  videoRef: (element: HTMLVideoElement | null) => void
  title: string
  artworkUrl: string
  failed: boolean
  videoActive: boolean
  hls: HlsSessionState
  onError: () => void
}) {
  if (file.availability !== 'available') {
    return <FallbackCard file={file} message="This file is missing on disk." />
  }
  if (file.media_kind === 'image' && file.supported && !failed) {
    return <ImageStage key={file.id} file={file} onError={onError} />
  }
  // The playback decision now drives video playability (M7): a source may need a
  // remux/transcode HLS session, so the manifest's direct-only `playable` flag
  // no longer gates the stage.
  if (file.media_kind === 'video' && videoActive && playable && !failed) {
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
  if (
    file.media_kind === 'video' &&
    !failed &&
    (hls.status === 'deciding' || hls.status === 'idle')
  ) {
    return <div className="mv-state">Preparing playback…</div>
  }
  if (file.media_kind === 'video' && !failed && hls.status === 'unavailable') {
    return (
      <FallbackCard
        file={file}
        message={hls.reason}
        heading="Playback server is unavailable."
        action={{ label: 'Try again', onClick: hls.retry }}
      />
    )
  }
  if (file.media_kind === 'video' && !failed && hls.status === 'error') {
    return (
      <FallbackCard
        file={file}
        message={hls.reason || playable?.reason || 'This video cannot be played in the browser.'}
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
  action,
}: {
  file: FileRead
  message: string
  heading?: string
  action?: { label: string; onClick: () => void }
}) {
  const meta = (file.tech_metadata ?? {}) as Record<string, unknown>
  const dims = formatDimensions(meta.width as number, meta.height as number)
  const dur = formatDuration(meta.duration as number)
  const metaText = `${file.role} · ${dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}`
  return <MediaFallback heading={heading} message={message} meta={metaText} action={action} />
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
