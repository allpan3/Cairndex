import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import {
  type FileRead,
  type PlayableVideo,
  type PlaybackManifest,
  thumbnailUrl,
  updatePlaybackProgress,
} from '../../api/client'
import {
  useBundle,
  useBundleCursor,
  useBundleFiles,
  useFileMutations,
  usePlaybackManifest,
} from '../../api/hooks'
import { useViewerMenu } from '../../desktop/useViewerMenu'
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
import { usePlayer, type PlayerController } from './player/usePlayer'
import { useShortcuts } from './player/useShortcuts'
import { consumeEndedTransition, handlePlaybackEnded } from './player/endBehavior'

interface MediaViewerProps {
  bundleId: string
  initialFileId?: string | null
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onClose: () => void
}

// A native progressive video has no HLS session to re-attach, so a transient
// media error (a dropped/slow range read while seeking into an unbuffered
// region — common on network storage or heavy 4K decode) would otherwise
// dead-end on the unplayable card with no way back. Reload the source at the
// current playhead this many times before giving up, mirroring the HLS
// re-attach budget.
const MAX_NATIVE_RECOVER = 3

// A load that never reaches metadata emits no error event — e.g. the range
// request wedged on a half-open connection after a proxy/server reset — so the
// player would sit on a silent black frame forever. If a source is still below
// HAVE_METADATA after this window, treat it as a stage error: a recovery
// reload opens a fresh connection, and an exhausted budget surfaces the
// retryable "Playback interrupted" card instead of a dead player.
const LOAD_WATCHDOG_MS = 15_000

/** Unified bundle media lightbox for direct-play M2 video and simple images. */
export function MediaViewer({
  bundleId,
  initialFileId,
  playerPrefs,
  onPlayerPrefs,
  onClose,
}: MediaViewerProps) {
  const qc = useQueryClient()
  const fileMutations = useFileMutations(bundleId)
  const { mutate: rememberCursor } = useBundleCursor(bundleId)
  const rememberedCursorRef = useRef<string | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { data: bundle, isLoading: bundleLoading, error: bundleError } = useBundle(bundleId)
  const { data: files = [], isLoading: filesLoading, error: filesError } = useBundleFiles(bundleId)
  const {
    data: manifest,
    isLoading: playbackLoading,
    error: playbackError,
  } = usePlaybackManifest(bundleId)
  const hasMissingFiles = files.some((file) => file.availability !== 'available')
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [failedFileId, setFailedFileId] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [fileLoop, setFileLoop] = useState(false)
  const endedHandledRef = useRef(false)
  const endedContextRef = useRef<{
    fileLoop: boolean
    player: PlayerController | null
    step: (delta: number) => void
  }>({ fileLoop: false, player: null, step: () => {} })
  const [resumeNotice, setResumeNotice] = useState<{ fileId: string; position: number } | null>(
    null,
  )

  const playlistFiles = useMemo(
    () =>
      files.filter(
        (file) => file.supported && (file.media_kind === 'image' || file.media_kind === 'video'),
      ),
    [files],
  )
  const preferredId = bundle
    ? ((initialFileId && playlistFiles.some((file) => file.id === initialFileId)
        ? initialFileId
        : null) ??
      (bundle.resume_file_id && playlistFiles.some((file) => file.id === bundle.resume_file_id)
        ? bundle.resume_file_id
        : null) ??
      playlistFiles.find((file) => file.availability === 'available')?.id ??
      playlistFiles[0]?.id ??
      null)
    : null
  const selectedId =
    pickedId && playlistFiles.some((file) => file.id === pickedId) ? pickedId : preferredId
  const currentIndex = selectedId ? playlistFiles.findIndex((file) => file.id === selectedId) : -1
  const current = currentIndex >= 0 ? playlistFiles[currentIndex] : null
  const failed = current ? failedFileId === current.id : false
  const currentId = current?.id ?? null

  useEffect(() => {
    rememberedCursorRef.current = null
  }, [bundleId])
  useEffect(() => {
    if (
      !currentId ||
      current?.availability !== 'available' ||
      rememberedCursorRef.current === currentId
    )
      return
    rememberedCursorRef.current = currentId
    rememberCursor(currentId)
  }, [current?.availability, currentId, rememberCursor])
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
  // Bounded native-error recovery budget (see MAX_NATIVE_RECOVER); refunded on a
  // fresh file and on healthy playback progress.
  const nativeRecoverRef = useRef(0)
  // A native recovery is in flight (decision requested, new source not yet
  // applied). A dying pipeline can emit several error events in one burst —
  // and continued drag-seeks on the errored element add more — so without this
  // guard a single failure could burn the whole budget at once. Mirrors the
  // HLS path's reattachingRef; cleared when the retried source is applied.
  const nativeRecoveringRef = useRef(false)
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
  // A fresh file refunds the native-recovery budget.
  useEffect(() => {
    nativeRecoverRef.current = 0
    nativeRecoveringRef.current = false
  }, [currentId])
  // The retried decision resolved into a (new) source object and the engine
  // reloaded — the recovery window is over. If this reload is also broken, its
  // own error event must count against the budget again.
  useEffect(() => {
    nativeRecoveringRef.current = false
  }, [source])
  const lastTimeRef = useRef(0)
  useEffect(() => {
    const delta = player.currentTime - lastTimeRef.current
    lastTimeRef.current = player.currentTime
    // Healthy forward progress refunds both recovery budgets so a later,
    // unrelated glitch still gets its full allotment of retries.
    if (delta > 0 && delta < 1.5) {
      notePlaying()
      nativeRecoverRef.current = 0
    }
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
  const chromeIdle = useIdleHide(rootRef, scrubbing)
  const title = bundle?.title ?? current?.display_title ?? 'Media'
  const artworkUrl = thumbnailUrl(bundleId, bundle?.updated_at ?? null)

  useEffect(() => rootRef.current?.focus(), [])

  // Bundle reads can persist a newly missing path, so refresh its library views
  useEffect(() => {
    if (!hasMissingFiles) return
    qc.invalidateQueries({ queryKey: ['view-counts'] })
    qc.invalidateQueries({ queryKey: ['browse'] })
  }, [hasMissingFiles, qc])

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
  const { reattach, retry: retryPlayback } = hls
  const handleStageError = useCallback(() => {
    // An HLS session that idled out (long pause) or hit an hls.js fatal error
    // re-attaches transparently at the current playhead.
    if (reattach()) return
    // Native progressive playback has no session to re-attach. A transient media
    // error — e.g. a range read that stalls/drops while seeking into an
    // unbuffered region — would otherwise dead-end here. Reload the source at
    // the current playhead a bounded number of times before giving up.
    if (source?.kind !== 'hls') {
      // Swallow the extra error events of a single failure burst while the
      // recovery decision is in flight (see nativeRecoveringRef).
      if (nativeRecoveringRef.current) return
      if (nativeRecoverRef.current < MAX_NATIVE_RECOVER) {
        nativeRecoverRef.current += 1
        nativeRecoveringRef.current = true
        retryPlayback()
        return
      }
    }
    if (currentId) setFailedFileId(currentId)
  }, [currentId, reattach, retryPlayback, source?.kind])
  // Manually recover from the failed card: clear the failure, refund the budget,
  // and re-decide at the current playhead.
  const retryFailedPlayback = useCallback(() => {
    nativeRecoverRef.current = 0
    nativeRecoveringRef.current = false
    setFailedFileId(null)
    retryPlayback()
  }, [retryPlayback])
  // Load watchdog (see LOAD_WATCHDOG_MS): a wedged load produces no error
  // event, so poke the stage-error path if metadata never arrives. Kept in a
  // ref so the effect doesn't re-arm on every handler identity change.
  const handleStageErrorRef = useRef(handleStageError)
  useEffect(() => {
    handleStageErrorRef.current = handleStageError
  }, [handleStageError])
  useEffect(() => {
    const video = videoElement
    if (!video || !source) return
    let timer: number | null = null
    const disarm = () => {
      if (timer != null) {
        window.clearTimeout(timer)
        timer = null
      }
    }
    const arm = () => {
      disarm()
      timer = window.setTimeout(() => {
        timer = null
        if (video.readyState < HTMLMediaElement.HAVE_METADATA) handleStageErrorRef.current()
      }, LOAD_WATCHDOG_MS)
    }
    // The engine may already have called load() (loadstart fired before this
    // effect ran), so arm unconditionally when metadata is still missing.
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) arm()
    video.addEventListener('loadstart', arm)
    video.addEventListener('loadedmetadata', disarm)
    // A real error already reaches the stage-error path via the element's
    // error handler; the watchdog must not fire a second time on top of it.
    video.addEventListener('error', disarm)
    return () => {
      disarm()
      video.removeEventListener('loadstart', arm)
      video.removeEventListener('loadedmetadata', disarm)
      video.removeEventListener('error', disarm)
    }
  }, [source, videoElement])

  const step = useCallback(
    (delta: number) => {
      if (currentIndex < 0) return
      const next = currentIndex + delta
      if (next >= 0 && next < playlistFiles.length) setPickedId(playlistFiles[next]?.id ?? null)
    },
    [currentIndex, playlistFiles],
  )

  useEffect(() => {
    endedContextRef.current = { fileLoop, player, step }
  }, [fileLoop, player, step])

  // Consume each ended transition once; live refs keep identity/settings
  // changes from re-firing it while the media remains ended
  useEffect(() => {
    consumeEndedTransition(player.status, endedHandledRef, () => {
      const context = endedContextRef.current
      if (context.player) {
        handlePlaybackEnded(context.fileLoop, context.player, () => context.step(1))
      }
    })
  }, [player.status])

  const useCurrentFrameAsCover = useCallback(() => {
    if (!currentId) return
    fileMutations.setCoverFrame.mutate({ fileId: currentId, time: player.currentTime })
  }, [currentId, fileMutations.setCoverFrame, player.currentTime])
  const clearCurrentCoverFrame = useCallback(() => {
    if (!currentId) return
    fileMutations.clearCoverFrame.mutate(currentId)
  }, [currentId, fileMutations.clearCoverFrame])

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

  const shortcutActions = useMemo(
    () => ({
      close: onClose,
      toggleInfo,
      snapshot,
      previous: () => step(-1),
      next: () => step(1),
    }),
    [onClose, toggleInfo, snapshot, step],
  )

  useShortcuts(rootRef, videoActive ? player : null, shortcutActions)
  // Native Playback menu items drive the same commands as the key bindings, and
  // the menu is live only while this viewer is mounted (plan 3 §7).
  useViewerMenu(videoActive ? player : null, shortcutActions)

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
          current
            ? `${current.display_title} · ${currentIndex + 1} / ${playlistFiles.length}`
            : 'Media'
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
        disabled={currentIndex < 0 || currentIndex >= playlistFiles.length - 1}
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
        {!loading && !error && files.length > 0 && playlistFiles.length === 0 && (
          <div className="mv-state">This bundle has no previewable media.</div>
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
            onRetryFailed={retryFailedPlayback}
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
          onDragChange={setScrubbing}
          fileLoop={fileLoop}
          onFileLoop={setFileLoop}
          onUseCoverFrame={useCurrentFrameAsCover}
          onClearCoverFrame={clearCurrentCoverFrame}
          hasCoverFrame={current?.cover_time != null}
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
  onRetryFailed,
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
  onRetryFailed: () => void
}) {
  if (file.availability !== 'available') {
    return (
      <FallbackCard
        file={file}
        heading="Missing file."
        message="This file is no longer available at its linked path."
      />
    )
  }
  // A video whose playback errored out (after exhausting auto-recovery) — offer a
  // manual retry that reloads at the current playhead instead of a dead end.
  if (file.media_kind === 'video' && failed) {
    return (
      <FallbackCard
        file={file}
        heading="Playback interrupted."
        message="The video stopped unexpectedly — this can happen after seeking into a part that hasn’t loaded yet. Try again to resume."
        action={{ label: 'Try again', onClick: onRetryFailed }}
      />
    )
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
          <dd>{fileRoleLabel(file)}</dd>
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
  const metaText = `${fileRoleLabel(file)} · ${dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(file.size_bytes)}`
  return <MediaFallback heading={heading} message={message} meta={metaText} action={action} />
}

// Hide the retired primary-video label while preserving legacy stored roles
function fileRoleLabel(file: FileRead): string {
  return file.role === 'primary_video' ? 'video' : file.role
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
