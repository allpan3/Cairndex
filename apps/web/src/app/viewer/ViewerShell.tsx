import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { type PlayableVideo, type PlaybackManifest, updatePlaybackProgress } from '../../api/client'
import { useViewerMenu } from '../../desktop/useViewerMenu'
import { getHostPlatform, isDesktopHost } from '../../platform'
import { contactSheetMenuItem, type ContactSheetTarget } from '../contactSheetExport'
import { ContactSheetDialog } from '../ContactSheetDialog'
import { ContextMenu } from '../ContextMenu'
import { IconAlert, IconFile, IconFilm, IconImage, IconMusic, IconSidebar } from '../icons'
import { Inspector } from '../Inspector'
import {
  BundleInspectorActionsContext,
  useBundleInspectorActions,
  useMergedBundleInspectorActions,
  type BundleInspectorActions,
} from '../bundleInspectorActions'
import { type MenuEntry, useContextMenu } from '../useContextMenu'
import {
  formatBitrate,
  formatBytes,
  formatClock,
  formatCodec,
  formatDimensions,
  formatDuration,
  formatVideoEncoding,
} from '../../lib/format'
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
import { classifyMediaError, type PlaybackFailureKind } from './player/mediaError'

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

/** Cover-frame actions the owning surface supplies, when the item is indexed. */
export interface ShellCoverActions {
  /** Use the frame at this playhead offset as *this file's* cover thumbnail.
   *  It does not decide which member represents the bundle — that is the file
   *  list's own affordance (owner, 2026-07-30). */
  onUseFrame: (time: number) => void
  /** Return this file's thumbnail to an automatically extracted frame. */
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
  // The info sidebar's visibility is a persisted player pref, so "expand" and
  // "hide" survive stepping files and reopening the viewer.
  const infoOpen = playerPrefs.infoOpen
  const inspectorOpen = playerPrefs.inspectorOpen
  // Which file failed, and how. The kind decides the card: a decode/format
  // rejection is deterministic — the engine has already refused these bytes, so
  // a retry replays the same refusal — while a network or aborted read is worth
  // retrying. Conflating them is what made a hard codec failure read as a
  // buffering hiccup with a button that could never work.
  const [failure, setFailure] = useState<{ key: string; kind: PlaybackFailureKind } | null>(null)
  const [scrubbing, setScrubbing] = useState(false)
  const [fileLoop, setFileLoop] = useState(false)
  const endedHandledRef = useRef(false)
  const endedContextRef = useRef<{
    fileLoop: boolean
    player: PlayerController | null
    step: (delta: number) => void
  }>({ fileLoop: false, player: null, step: () => {} })
  const [resumeNotice, setResumeNotice] = useState<{ key: string; position: number } | null>(null)
  // Transient feedback for exports ("Building contact sheet…" / errors) — the
  // viewer has no toast bus of its own.
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  // The file whose contact-sheet options are open, if any.
  const [sheetTarget, setSheetTarget] = useState<ContactSheetTarget | null>(null)

  const hasError = Boolean(error)
  const current = items[index] ?? null
  const currentKey = current?.key ?? null
  // Identity comes from the item, not the playback entry: a synthesized entry for
  // an unindexed path has no file id, and nothing keyed on one may fire for it.
  const fileId = current?.fileId ?? null
  const bundleId = current?.bundleId ?? null
  const failedKind = currentKey !== null && failure?.key === currentKey ? failure.kind : null
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
  const contextMenu = useContextMenu()
  const closeContextMenu = contextMenu.close
  // The context menu dismisses on mousedown; without this the *same* gesture's
  // click reached the video and toggled playback, so closing the menu paused the
  // film (owner, 2026-07-27). Recorded in the capture phase, which runs before
  // the menu's own window listener.
  const dismissedMenuRef = useRef(false)

  useEffect(() => rootRef.current?.focus(), [])

  useEffect(() => {
    if (resumeNotice === null) return
    const timer = window.setTimeout(() => setResumeNotice(null), 6000)
    return () => window.clearTimeout(timer)
  }, [resumeNotice])

  const toggleInfo = useCallback(
    () => onPlayerPrefs((previous) => ({ ...previous, infoOpen: !previous.infoOpen })),
    [onPlayerPrefs],
  )
  const toggleInspector = useCallback(
    () => onPlayerPrefs((previous) => ({ ...previous, inspectorOpen: !previous.inspectorOpen })),
    [onPlayerPrefs],
  )
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
  const handleStageError = useCallback(
    (mediaError?: MediaError | null) => {
      // A format the engine has already refused cannot be recovered by opening
      // the same bytes again: re-attaching or reloading would replay the refusal
      // and burn the budget on the way to the same card. Fail straight to the
      // explanatory version instead.
      if (classifyMediaError(mediaError) === 'unsupported') {
        if (currentKey) setFailure({ key: currentKey, kind: 'unsupported' })
        return
      }
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
      if (currentKey) setFailure({ key: currentKey, kind: 'interrupted' })
    },
    [currentKey, reattach, retryPlayback, source?.kind],
  )
  // Manually recover from the failed card: clear the failure, refund the budget,
  // and re-decide at the current playhead.
  const retryFailedPlayback = useCallback(() => {
    nativeRecoverRef.current = 0
    nativeRecoveringRef.current = false
    setFailure(null)
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

  // What the docked Bundle Inspector's actions mean *here*. Everything not
  // listed is inherited from the shell unchanged — the whole point of the
  // context (see `bundleInspectorActions.tsx`). Five actions genuinely differ
  // inside an open viewer, and each is resolved rather than dropped:
  const {
    onPlayFile: shellPlayFile,
    onLocateFile: shellLocateFile,
    onAddFiles: shellAddFiles,
    onFilterByTags: shellFilterByTags,
    onOpenCollection: shellOpenCollection,
  } = useBundleInspectorActions()
  const inspectorOverrides = useMemo<BundleInspectorActions>(
    () => ({
      // Play, from a viewer that is already open on this bundle, is a step
      // within the playlist rather than a second viewer stacked on the first.
      onPlayBundle: () => onIndex(0),
      onPlayFile: (targetBundleId, fileId) => {
        const at = items.findIndex((item) => item.fileId === fileId)
        if (at >= 0) {
          onIndex(at)
          return
        }
        // Not in this playlist (another bundle, or a file the playlist skips):
        // fall back to the shell, which retargets this same viewer rather than
        // opening another one.
        shellPlayFile?.(targetBundleId, fileId)
      },
      // These four take the owner somewhere in the shell — a File Browser
      // directory, the "Add files" dialog, a tag-filtered grid, or a collection — all of which
      // are behind a full-screen viewer. Close it first: navigating the shell
      // underneath an opaque overlay is what "nothing happened" looks like.
      onLocateFile: shellLocateFile && ((path) => (onClose(), shellLocateFile(path))),
      onAddFiles: shellAddFiles && ((id) => (onClose(), shellAddFiles(id))),
      onFilterByTags: shellFilterByTags && ((ids) => (onClose(), shellFilterByTags(ids))),
      onOpenCollection:
        shellOpenCollection && ((collectionId) => (onClose(), shellOpenCollection(collectionId))),
      // The shell's flash toast sits below the viewer's z-index, so reporting
      // through it is the same as not reporting at all — which is why a tag
      // edit in here finished with no sign it had (owner, 2026-07-30). The
      // viewer already owns a notice anchor above its own chrome; use that.
      onFlash: setExportNotice,
    }),
    [
      items,
      onClose,
      onIndex,
      shellAddFiles,
      shellFilterByTags,
      shellLocateFile,
      shellOpenCollection,
      shellPlayFile,
    ],
  )
  const mergedInspectorActions = useMergedBundleInspectorActions(inspectorOverrides)

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
      const name = `${safeName(current?.title ?? title)}.png`
      // Desktop: through the shell, which saves into the configured export
      // folder (Settings → Exports) or asks via the native dialog. A browser
      // can only download, so it keeps the anchor.
      if (isDesktopHost()) {
        void blob.arrayBuffer().then((buffer) => {
          void getHostPlatform()
            .saveExport(name, new Uint8Array(buffer))
            .catch(() => {
              // Fall back to a plain download rather than losing the frame.
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = name
              a.click()
              URL.revokeObjectURL(url)
            })
        })
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      a.click()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }, [current?.title, title, videoElement])

  const contactSheetTarget = useMemo(
    () =>
      current?.fileId && isVideo
        ? {
            fileId: current.fileId,
            title: current.title,
            sizeBytes: current.sizeBytes,
            duration: current.duration,
            width: current.width,
            height: current.height,
            fps: current.fps,
            mimeType: current.mimeType,
            videoCodec: current.videoCodec,
            audioCodec: current.audioCodec,
          }
        : null,
    [current, isVideo],
  )

  useEffect(() => {
    if (exportNotice === null || exportNotice.endsWith('…')) return
    const timer = window.setTimeout(() => setExportNotice(null), 5000)
    return () => window.clearTimeout(timer)
  }, [exportNotice])

  const contextMenuOpen = contextMenu.state !== null
  const shortcutActions = useMemo(
    () => ({
      // While the right-click menu is up, Escape belongs to it — without this
      // the same keydown closed the menu *and* fell through to close the whole
      // viewer (caught by the controls e2e when the menu landed).
      close: contextMenuOpen ? closeContextMenu : onClose,
      toggleInfo,
      snapshot,
      previous: () => step(-1),
      next: () => step(1),
      // `player` exists even for image bundles (only its use as a *controller* is
      // gated on videoActive), so fullscreen state stays correct for images too.
      isFullscreen: () => player.fullscreen,
      exitFullscreen: () => player.toggleFullscreen(),
    }),
    [contextMenuOpen, closeContextMenu, onClose, toggleInfo, snapshot, step, player],
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

  // Right-click gets the app's menu, not the browser's. The native <video> menu
  // was the only thing on this gesture, and half its entries drive the element
  // directly ("Show all controls", downloading the raw source) — controls the
  // custom player deliberately replaced (owner report, 2026-07-27; the seam
  // VideoStage reserved on 2026-07-19).
  const openViewerContextMenu = (e: React.MouseEvent) => {
    // Text fields keep their native menu (copy/paste); everything else is ours.
    const target = e.target as HTMLElement
    if (target.closest('input, textarea, select')) return
    // The docked inspector brings its own menus — for a tag pill, for a file
    // row — exactly as it does in the shell. This handler sits on the viewer
    // root, so without this those gestures opened the playback menu *as well*,
    // stacked on top of the menu the click was actually asking for (owner:
    // "different right-click context menus", 2026-07-30). The rail is the
    // inspector's surface; the viewer's menu belongs to the media.
    if (target.closest('.inspector')) return
    e.preventDefault()
    const entries: MenuEntry[] = []
    if (videoActive) {
      entries.push(
        { label: player.status === 'playing' ? 'Pause' : 'Play', onClick: player.playPause },
        null,
        {
          label: player.subtitlesOn ? 'Hide Subtitles' : 'Show Subtitles',
          disabled: !(playable?.subtitles ?? []).some((track) => track.src),
          onClick: player.toggleSubtitles,
        },
        {
          label: fileLoop ? 'Stop Looping File' : 'Loop File',
          onClick: () => setFileLoop(!fileLoop),
        },
        null,
      )
      if (coverActions) {
        entries.push(
          // "Video", not "cover", because this sets the thumbnail of the file
          // being watched and nothing else. It used to promote that file to the
          // bundle's cover as well, which made choosing a nicer frame for one
          // video quietly re-pick what represented the whole bundle (owner,
          // 2026-07-30). That promotion is its own step — the star beside each
          // row in the inspector's file list, which is docked right here.
          { label: 'Set Frame as Video Cover', onClick: coverActions.onUse },
          {
            // Its only home now that the settings menu dropped the cover group —
            // without it, a chosen frame could be set but never undone.
            label: 'Reset Video Cover to Default',
            disabled: !coverActions.hasCoverFrame,
            onClick: coverActions.onClear,
          },
        )
      }
      entries.push(
        { label: 'Save Snapshot', onClick: snapshot },
        // A bare path has no file row, and the grid is cut server-side from the
        // indexed file — so unindexed videos show the row disabled rather than
        // a submenu that cannot do anything.
        contactSheetTarget
          ? contactSheetMenuItem(contactSheetTarget, setSheetTarget)
          : { label: 'Save Contact Sheet', disabled: true, onClick: () => {} },
      )
      entries.push(null)
    }
    entries.push(
      { label: infoOpen ? 'Hide Info' : 'Show Info', onClick: toggleInfo },
      {
        label: inspectorOpen ? 'Hide Bundle Inspector' : 'Show Bundle Inspector',
        // An unindexed File Browser path has no bundle to inspect.
        disabled: !current?.bundleId,
        onClick: toggleInspector,
      },
      {
        label: player.fullscreen ? 'Exit Full Screen' : 'Full Screen',
        onClick: player.toggleFullscreen,
      },
      null,
      { label: 'Close Viewer', onClick: onClose },
    )
    contextMenu.open(e, entries)
  }

  return (
    <div
      onContextMenu={openViewerContextMenu}
      onMouseDownCapture={() => {
        dismissedMenuRef.current = contextMenu.state !== null
      }}
      className={`media-viewer${chromeIdle ? ' media-viewer--idle' : ''}${
        inspectorOpen && current?.bundleId ? ' media-viewer--railed' : ''
      }`}
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
        inspectorOpen={inspectorOpen}
        canInspect={Boolean(current?.bundleId)}
        onToggleInspector={toggleInspector}
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

      <div
        className="mv-stage"
        // Double-click closes the viewer, the way a full-screen picture viewer
        // does (owner, 2026-07-27). The two clicks underneath have already
        // toggled playback twice, which lands back where it started, so nothing
        // needs undoing here.
        onDoubleClick={(event) => {
          if (event.target !== event.currentTarget && !isStageSurface(event.target)) return
          onClose()
        }}
      >
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
            failedKind={failedKind}
            videoActive={videoActive}
            hls={hls}
            onError={handleStageError}
            onFailed={(mediaError) =>
              currentKey && setFailure({ key: currentKey, kind: classifyMediaError(mediaError) })
            }
            onRetryFailed={retryFailedPlayback}
            onActivate={() => {
              if (dismissedMenuRef.current) {
                dismissedMenuRef.current = false
                return
              }
              player.playPause()
            }}
          />
        )}
      </div>

      {/* Every transient viewer message shares one anchor and one frame, so two
          of them stack instead of sitting at two different heights in two
          different styles (owner, 2026-07-30). The export notice goes above the
          resume notice, which stays nearest the seek track it refers to. */}
      {(visibleResume !== null || exportNotice !== null) && (
        <div className="mv-toasts">
          {exportNotice !== null && <div className="mv-toast mv-export-notice">{exportNotice}</div>}
          {visibleResume !== null && (
            <button className="mv-toast mv-resume" type="button" onClick={restartFromBeginning}>
              Resumed at {formatClock(visibleResume)} <span>Click to restart</span>
            </button>
          )}
        </div>
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
        />
      )}

      {infoOpen && current && (
        <InfoPanel
          item={current}
          playable={playable}
          items={items}
          index={index}
          onIndex={onIndex}
        />
      )}

      {/* The shell's inspector, not a copy of it: same component, same actions,
          and — through `--inspector-w` — the same width as the rail it mirrors,
          so resizing one is resizing both (owner, 2026-07-30). It is placed
          straight into the viewer's grid rather than wrapped in a rail element
          of its own; the wrapper was the second, divergent style contract. */}
      {inspectorOpen && current?.bundleId && (
        <BundleInspectorActionsContext value={mergedInspectorActions}>
          <Inspector bundleId={current.bundleId} />
        </BundleInspectorActionsContext>
      )}

      <ContextMenu state={contextMenu.state} onClose={contextMenu.close} />
      {sheetTarget && (
        <ContactSheetDialog
          target={sheetTarget}
          onClose={() => setSheetTarget(null)}
          onReport={setExportNotice}
        />
      )}
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
  failedKind,
  videoActive,
  hls,
  onActivate,
  onError,
  onFailed,
  onRetryFailed,
}: {
  item: ViewerItem
  playable: PlayableVideo | null
  player: PlayerController
  videoRef: (element: HTMLVideoElement | null) => void
  title: string
  artworkUrl: string
  /** How the current file failed, or null while it has not. */
  failedKind: PlaybackFailureKind | null
  videoActive: boolean
  hls: HlsSessionState
  /** Left-click on the video stage (guarded against menu-dismiss clicks). */
  onActivate: () => void
  /** Video-stage errors: routed through re-attach/reload recovery first. */
  onError: (mediaError?: MediaError | null) => void
  /** Unrecoverable media errors: straight to the failed card, no recovery. */
  onFailed: (mediaError: MediaError | null) => void
  onRetryFailed: () => void
}) {
  const failed = failedKind !== null
  if (!item.available) {
    return (
      <FallbackCard
        item={item}
        heading="Missing file."
        message="This file is no longer available at its linked path."
      />
    )
  }
  // The engine refused the media itself. No retry: it would replay the same
  // refusal, and offering one invites the user to keep pressing a button that
  // cannot work. Say the file is the problem and point somewhere useful.
  if (item.mediaKind === 'video' && failedKind === 'unsupported') {
    return (
      <FallbackCard
        item={item}
        icon={<IconAlert />}
        heading="This video can’t be played here."
        message="Its format isn’t one this player can decode, so retrying won’t help. Collecting metadata for the library may let the server convert it on the fly; otherwise it will need converting."
      />
    )
  }
  // Playback stopped after auto-recovery was exhausted, but the media itself was
  // never refused — delivery failed. A manual retry reloads at the current
  // playhead, which genuinely can succeed.
  if (item.mediaKind === 'video' && failed) {
    return (
      <FallbackCard
        item={item}
        icon={<IconAlert />}
        heading="Playback interrupted."
        message="The video stopped before it finished loading — a dropped or stalled read, which is common over network storage. Try again to resume from here."
        action={{ label: 'Try again', onClick: onRetryFailed }}
      />
    )
  }
  if (item.mediaKind === 'image' && item.supported && !failed) {
    return <ImageStage key={item.key} item={item} onError={onError} />
  }
  // Audio keeps the native element the old File Browser lightbox used: there is
  // no decision/session pipeline for it, so its errors are unrecoverable and go
  // straight to the failed card rather than through the video recovery budget.
  if (item.mediaKind === 'audio' && item.supported && !failed) {
    return (
      <audio
        key={item.key}
        className="mv-audio"
        src={item.contentUrl}
        controls
        autoPlay
        onError={(event) => onFailed(event.currentTarget.error)}
        data-testid="media-audio"
      />
    )
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
        onActivate={onActivate}
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

/**
 * Whether a double-click landed on the media rather than an overlay control.
 *
 * `mv-image-stage` has to be here even though the image itself is an `IMG`:
 * the image stage captures the pointer to pan, and capture retargets the later
 * click and double-click to the capturing element. So a double-click on a
 * picture arrives with the *stage* as its target, and without this the viewer
 * would not close on one (owner report, 2026-07-30).
 */
function isStageSurface(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.tagName === 'VIDEO' ||
    target.tagName === 'IMG' ||
    target.classList.contains('mv-video-stage') ||
    target.classList.contains('mv-image-stage') ||
    target.classList.contains('mv-state')
  )
}

const Topbar = memo(function Topbar({
  title,
  subtitle,
  infoOpen,
  onToggleInfo,
  inspectorOpen,
  canInspect,
  onToggleInspector,
  onClose,
}: {
  title: string
  subtitle: string
  infoOpen: boolean
  onToggleInfo: () => void
  inspectorOpen: boolean
  canInspect: boolean
  onToggleInspector: () => void
  onClose: () => void
}) {
  return (
    // Draggable like every other top bar: the viewer covers the whole window, so
    // without this the shell has no grab area at all while media is open (owner,
    // 2026-07-27). "deep" so the title text inside it drags too; the buttons
    // opt out below.
    <div className="mv-topbar" data-tauri-drag-region="deep">
      <div>
        <div className="mv-title">{title}</div>
        <div className="mv-subtitle">{subtitle}</div>
      </div>
      <div className="mv-topbar__actions" data-tauri-drag-region="false">
        <button
          className={`mv-icon${infoOpen ? ' is-active' : ''}`}
          onClick={onToggleInfo}
          aria-label="Info"
          title="Info"
        >
          i
        </button>
        <button
          className={`mv-icon${inspectorOpen ? ' is-active' : ''}`}
          onClick={onToggleInspector}
          aria-label={inspectorOpen ? 'Hide bundle inspector' : 'Show bundle inspector'}
          aria-pressed={inspectorOpen}
          title="Bundle inspector"
          disabled={!canInspect}
        >
          <IconSidebar />
        </button>
        <button className="mv-icon" onClick={onClose} aria-label="Close" title="Close">
          ×
        </button>
      </div>
    </div>
  )
})

/** The bundle inspector + playlist, alongside the playing media.
 *
 * The owner asked for *the* inspector here — the editable one with tags,
 * collections and metadata — not a read-only echo of it (2026-07-27), so this
 * embeds the real component rather than restating its fields. Its pickers portal
 * above the viewer (see `.picker__panel`), and the viewer's keyboard map already
 * ignores keystrokes aimed at text fields, so typing a tag never reaches the
 * player.
 *
 * An unindexed File Browser path has no bundle to inspect and keeps the plain
 * metadata card. */
function InfoPanel({
  item,
  playable,
  items,
  index,
  onIndex,
}: {
  item: ViewerItem
  playable: PlayableVideo | null
  items: ViewerItem[]
  index: number
  onIndex: (index: number) => void
}) {
  const dims = formatDimensions(item.width, item.height)
  const dur = formatDuration(item.duration)
  const subtitles = playable?.subtitles.filter((track) => track.src).map((track) => track.label)
  // Media facts and the playlist, for both bundle files and File Browser paths.
  // Editing a bundle's metadata is the *inspector rail's* job, on its own
  // toggle — the owner wants the two panels separate (2026-07-27).
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
        {/* Encoding is what decides whether a file plays directly or needs a
            session, so it belongs where someone looks when it misbehaves. Rows
            appear only for a probed file rather than printing em-dashes. */}
        {item.videoCodec && (
          <div>
            <dt>Video</dt>
            <dd>
              {formatVideoEncoding(item.videoCodec, {
                bitDepth: item.bitDepth,
                hdr: item.hdr,
                fps: item.fps,
              })}
            </dd>
          </div>
        )}
        {item.audioCodec && (
          <div>
            <dt>Audio</dt>
            <dd>{formatCodec(item.audioCodec)}</dd>
          </div>
        )}
        {item.bitrate ? (
          <div>
            <dt>Bitrate</dt>
            <dd>{formatBitrate(item.bitrate)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Subtitles</dt>
          <dd>{subtitles && subtitles.length > 0 ? subtitles.join(', ') : '—'}</dd>
        </div>
      </dl>
      {items.length > 1 && <FileList items={items} index={index} onIndex={onIndex} />}
    </aside>
  )
}

/** The open playlist: every item, the current one marked, click to jump — so
 *  switching files never needs blind prev/next stepping. */
function FileList({
  items,
  index,
  onIndex,
}: {
  items: ViewerItem[]
  index: number
  onIndex: (index: number) => void
}) {
  return (
    <>
      <h4 className="mv-info__files-title">Files ({items.length})</h4>
      <div className="mv-info__files" role="listbox" aria-label="Files">
        {items.map((entry, i) => (
          <button
            key={entry.key}
            role="option"
            aria-selected={i === index}
            className={`mv-info__file${i === index ? ' is-current' : ''}`}
            onClick={() => onIndex(i)}
          >
            <span className="mv-info__file-name">{entry.title}</span>
            {entry.duration != null && <span>{formatDuration(entry.duration)}</span>}
          </button>
        ))}
      </div>
    </>
  )
}

/** Structured fallback for missing, unsupported, or failed items. */
function FallbackCard({
  item,
  message,
  heading = item.title,
  icon,
  action,
}: {
  item: ViewerItem
  message: string
  heading?: string
  icon?: ReactNode
  action?: { label: string; onClick: () => void }
}) {
  const dims = formatDimensions(item.width, item.height)
  const dur = formatDuration(item.duration)
  const metaText = `${item.typeLabel} · ${dims !== '—' ? dims : dur !== '—' ? dur : formatBytes(item.sizeBytes)}`
  return (
    <MediaFallback
      heading={heading}
      message={message}
      meta={metaText}
      // Absent an explicit icon, follow the media kind so an unsupported image
      // and an unsupported video are not the same card with different words.
      icon={icon ?? mediaKindIcon(item.mediaKind)}
      action={action}
    />
  )
}

/** The stage glyph for a media kind, for fallbacks with no more specific icon. */
function mediaKindIcon(kind: ViewerItem['mediaKind']): ReactNode {
  if (kind === 'video') return <IconFilm />
  if (kind === 'image') return <IconImage />
  if (kind === 'audio') return <IconMusic />
  return <IconFile />
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
