import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { type PlayableVideo, type PlaybackManifest, updatePlaybackProgress } from '../../api/client'
import { useViewerMenu } from '../../desktop/useViewerMenu'
import { formatBytes, formatClock, formatDimensions, formatDuration } from '../../lib/format'
import type { PlayerPrefs } from '../types'
import { ImageStage } from './ImageStage'
import { MediaFallback } from './MediaFallback'
import { VideoStage } from './VideoStage'
import type { ViewerItem } from './viewerItem'
import { getClientCapabilities } from './player/caps'
import { ControlBar } from './player/ControlBar'
import type { CoverFrameActions } from './player/SettingsMenu'
import { useHlsSession, type HlsSessionState } from './player/useHlsSession'
import { useIdleHide } from './player/useIdleHide'
import { usePlaybackProgressReporter } from './player/usePlaybackProgressReporter'
import { usePlayer, type PlayerController } from './player/usePlayer'
import { useShortcuts } from './player/useShortcuts'
import { consumeEndedTransition, handlePlaybackEnded } from './player/endBehavior'

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

/** Bundle-cover actions the owning surface supplies, when it has a bundle. */
export interface ShellCoverActions {
  /** Set the bundle cover to the frame at this playhead offset. */
  onUseFrame: (time: number) => void
  onClear: () => void
}

interface ViewerShellProps {
  /** The playlist, already scoped by whoever opened the viewer. */
  items: ViewerItem[]
  index: number
  onIndex: (index: number) => void
  /**
   * Playback entry for the current item: a manifest row for an indexed file, or
   * a synthesized direct entry for a bare path. Null while it is still resolving
   * or when the item is not a video.
   */
  playable: PlayableVideo | null
  /** Topbar heading — the bundle title, or the folder being browsed. */
  title: string
  /** MediaSession artwork; empty when the surface has no cover image. */
  artworkUrl: string
  playerPrefs: PlayerPrefs
  onPlayerPrefs: React.Dispatch<React.SetStateAction<PlayerPrefs>>
  onClose: () => void
  loading?: boolean
  error?: unknown
  /** Heading for the error state, e.g. "Couldn't load this bundle." */
  errorHeading?: string
  /** Replaces the stage when there is nothing to show at all. */
  emptyMessage?: string | null
  cover?: ShellCoverActions | null
}

/**
 * The shared media viewer: chrome, playback engine, and stages.
 *
 * Both browsing surfaces render this. The Bundle Browser drives it from a
 * bundle's files and playback manifest; the File Browser drives it from a
 * directory listing, keeping its own folder-scoped playlist. Everything
 * surface-specific — where the playlist comes from, how a playback entry is
 * resolved, whether a bundle cover can be set — is a prop, so neither surface
 * has to know about the other's identity model (see `ViewerItem`).
 */
export function ViewerShell({
  items,
  index,
  onIndex,
  playable,
  title,
  artworkUrl,
  playerPrefs,
  onPlayerPrefs,
  onClose,
  loading = false,
  error = null,
  errorHeading = 'Couldn’t load this media.',
  emptyMessage = null,
  cover = null,
}: ViewerShellProps) {
  const qc = useQueryClient()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [infoOpen, setInfoOpen] = useState(false)
  const [failedKey, setFailedKey] = useState<string | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [fileLoop, setFileLoop] = useState(false)
  const endedHandledRef = useRef(false)
  const endedContextRef = useRef<{
    fileLoop: boolean
    player: PlayerController | null
    step: (delta: number) => void
  }>({ fileLoop: false, player: null, step: () => {} })
  const [resumeNotice, setResumeNotice] = useState<{ key: string; position: number } | null>(null)

  const hasError = Boolean(error)
  const current = items[index] ?? null
  const currentKey = current?.key ?? null
  // Identity comes from the item, not the playback entry: a synthesized entry for
  // an unindexed path has no file id, and nothing keyed on one may fire for it.
  const fileId = current?.fileId ?? null
  const bundleId = current?.bundleId ?? null
  const failed = currentKey !== null && failedKey === currentKey
  const isVideo = current?.mediaKind === 'video'
  const videoAvailable = current?.available === true

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
    fileId: isVideo && videoAvailable ? fileId : null,
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
      if (currentKey) setResumeNotice({ key: currentKey, position })
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
  }, [currentKey])
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
    fileId,
    enabled: videoActive,
    status: player.status,
    currentTime: player.currentTime,
    duration: player.duration || playable?.duration || 0,
    completed: playable?.progress?.completed,
  })
  const chromeIdle = useIdleHide(rootRef, scrubbing)

  useEffect(() => rootRef.current?.focus(), [])

  useEffect(() => {
    if (resumeNotice === null) return
    const timer = window.setTimeout(() => setResumeNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [resumeNotice])

  const toggleInfo = useCallback(() => setInfoOpen((v) => !v), [])
  const playableDuration = playable?.duration ?? null
  const restartFromBeginning = useCallback(() => {
    player.seek(0)
    setResumeNotice(null)
    if (!fileId) return
    const duration =
      Number.isFinite(player.duration) && player.duration > 0 ? player.duration : playableDuration
    void updatePlaybackProgress(fileId, {
      position_s: 0,
      duration_s: duration ?? null,
    }).then((progress) => {
      if (bundleId) {
        qc.setQueryData<PlaybackManifest>(['playback', bundleId], (previous) =>
          previous
            ? {
                ...previous,
                videos: previous.videos.map((video) =>
                  video.file_id === fileId ? { ...video, progress } : video,
                ),
              }
            : previous,
        )
      }
      qc.invalidateQueries({ queryKey: ['continue-watching'] })
    })
  }, [bundleId, fileId, playableDuration, player, qc])
  const visibleResume =
    resumeNotice && resumeNotice.key === currentKey ? resumeNotice.position : null
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
    if (currentKey) setFailedKey(currentKey)
  }, [currentKey, reattach, retryPlayback, source?.kind])
  // Manually recover from the failed card: clear the failure, refund the budget,
  // and re-decide at the current playhead.
  const retryFailedPlayback = useCallback(() => {
    nativeRecoverRef.current = 0
    nativeRecoveringRef.current = false
    setFailedKey(null)
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
      const next = index + delta
      if (next >= 0 && next < items.length) onIndex(next)
    },
    [index, items.length, onIndex],
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
      a.download = `${safeName(current?.title ?? title)}.png`
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [current?.title, title, videoElement])

  const shortcutActions = useMemo(
    () => ({
      close: onClose,
      toggleInfo,
      snapshot,
      previous: () => step(-1),
      next: () => step(1),
      // `player` exists even for image bundles (only its use as a *controller* is
      // gated on videoActive), so fullscreen state stays correct for images too.
      isFullscreen: () => player.fullscreen,
      exitFullscreen: () => player.toggleFullscreen(),
    }),
    [onClose, toggleInfo, snapshot, step, player],
  )

  useShortcuts(rootRef, videoActive ? player : null, shortcutActions)
  // Native Playback menu items drive the same commands as the key bindings, and
  // the menu is live only while this viewer is mounted (plan 3 §7).
  useViewerMenu(videoActive ? player : null, shortcutActions)

  // The cover affordance needs the live playhead, and only applies to an item
  // that can actually own a bundle cover.
  const coverActions = useMemo<CoverFrameActions | null>(() => {
    if (!cover || !current?.canSetCover) return null
    return {
      onUse: () => cover.onUseFrame(player.currentTime),
      onClear: cover.onClear,
      hasCoverFrame: current.coverTime != null,
    }
  }, [cover, current?.canSetCover, current?.coverTime, player])

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
        subtitle={current ? `${current.title} · ${index + 1} / ${items.length}` : 'Media'}
        infoOpen={infoOpen}
        onToggleInfo={toggleInfo}
        onClose={onClose}
      />

      <button
        className="mv-nav mv-nav--prev"
        onClick={() => step(-1)}
        aria-label="Previous file"
        disabled={index <= 0}
      >
        ‹
      </button>
      <button
        className="mv-nav mv-nav--next"
        onClick={() => step(1)}
        aria-label="Next file"
        disabled={index < 0 || index >= items.length - 1}
      >
        ›
      </button>

      <div className="mv-stage">
        {loading && <div className="mv-state">Loading media…</div>}
        {!loading && hasError && (
          <div className="mv-state mv-state--error">
            <strong>{errorHeading}</strong>
            <code>{error instanceof Error ? error.message : 'Unknown error'}</code>
          </div>
        )}
        {!loading && !hasError && emptyMessage && <div className="mv-state">{emptyMessage}</div>}
        {!loading && !hasError && !emptyMessage && current && (
          <Stage
            item={current}
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
          cover={coverActions}
        />
      )}

      {infoOpen && current && <InfoPanel item={current} playable={playable} />}
    </div>
  )
}

/** Render the current item's stage or a structured fallback card. */
function Stage({
  item,
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
  item: ViewerItem
  playable: PlayableVideo | null
  player: PlayerController
  videoRef: (element: HTMLVideoElement | null) => void
  title: string
  artworkUrl: string
  failed: boolean
  videoActive: boolean
  hls: HlsSessionState
  onError: () => void
  onRetryFailed: () => void
}) {
  if (!item.available) {
    return (
      <FallbackCard
        item={item}
        heading="Missing file."
        message="This file is no longer available at its linked path."
      />
    )
  }
  // A video whose playback errored out (after exhausting auto-recovery) — offer a
  // manual retry that reloads at the current playhead instead of a dead end.
  if (item.mediaKind === 'video' && failed) {
    return (
      <FallbackCard
        item={item}
        heading="Playback interrupted."
        message="The video stopped unexpectedly — this can happen after seeking into a part that hasn’t loaded yet. Try again to resume."
        action={{ label: 'Try again', onClick: onRetryFailed }}
      />
    )
  }
  if (item.mediaKind === 'image' && item.supported && !failed) {
    return <ImageStage key={item.key} item={item} onError={onError} />
  }
  // The playback decision now drives video playability (M7): a source may need a
  // remux/transcode HLS session, so the manifest's direct-only `playable` flag
  // no longer gates the stage.
  if (item.mediaKind === 'video' && videoActive && playable && !failed) {
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
    item.mediaKind === 'video' &&
    !failed &&
    (hls.status === 'deciding' || hls.status === 'idle')
  ) {
    return <div className="mv-state">Preparing playback…</div>
  }
  if (item.mediaKind === 'video' && !failed && hls.status === 'unavailable') {
    return (
      <FallbackCard
        item={item}
        message={hls.reason}
        heading="Playback server is unavailable."
        action={{ label: 'Try again', onClick: hls.retry }}
      />
    )
  }
  if (item.mediaKind === 'video' && !failed && hls.status === 'error') {
    return (
      <FallbackCard
        item={item}
        message={hls.reason || playable?.reason || 'This video cannot be played in the browser.'}
        heading="Can’t play this in the browser."
      />
    )
  }
  return (
    <FallbackCard
      item={item}
      heading={failed ? 'Preview failed.' : undefined}
      message={
        failed
          ? "This file can't be shown in the browser."
          : `${item.mediaKind ?? 'These'} files can't be previewed here.`
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

/** Metadata side panel for the selected item. */
function InfoPanel({ item, playable }: { item: ViewerItem; playable: PlayableVideo | null }) {
  const dims = formatDimensions(item.width, item.height)
  const dur = formatDuration(item.duration)
  const subtitles = playable?.subtitles.filter((track) => track.src).map((track) => track.label)
  return (
    <aside className="mv-info">
      <h3>{item.title}</h3>
      <dl>
        <div>
          <dt>Type</dt>
          <dd>{item.typeLabel}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatBytes(item.sizeBytes)}</dd>
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

/** Structured fallback for missing, unsupported, or failed items. */
function FallbackCard({
  item,
  message,
  heading = item.title,
  action,
}: {
  item: ViewerItem
  message: string
  heading?: string
  action?: { label: string; onClick: () => void }
}) {
  const dims = formatDimensions(item.width, item.height)
  const dur = formatDuration(item.duration)
  const metaText = `${item.typeLabel} · ${dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(item.sizeBytes)}`
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
