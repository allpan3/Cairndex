import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import {
  HOVER_PREVIEW_DWELL_MS,
  HOVER_PREVIEW_PREFETCH_MS,
  HOVER_PREVIEW_REST_MS,
  hoverPreviewMode,
  hoverStartTime,
  hoverTimeForPointer,
  type HoverPreviewPhase,
  type HoverPreviewSource,
} from './hoverPreviewState'

// Page-wide preview ownership record
interface PreviewOwner {
  token: symbol
  stop: () => void
}

// Hooks run before and after one browser media seek
interface SeekCallbacks {
  beforeSeek?: (needsSeek: boolean) => void
  onReady: () => void
}

let currentOwner: PreviewOwner | null = null
const SEEK_READY_CHECK_MS = 750
const METADATA_READY_TIMEOUT_MS = 5_000
const FRAME_PRESENT_FALLBACK_MS = 250
const FRAME_TIME_TOLERANCE_S = 0.1
const SEEK_TIME_TOLERANCE_S = 0.05

// Detect whether this device offers a real mouse-style hover interaction
function hasFineHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return !window.matchMedia('(hover: none), (pointer: coarse)').matches
}

// Shared dwell, ownership, skim, and teardown state for every preview card
export function useHoverPreview(
  source: HoverPreviewSource | null,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  disabled = false,
  storyboardTimeForPosition?: (time: number) => number | null,
) {
  const previewFileId = source?.fileId ?? null
  const previewMediaKind = source?.mediaKind ?? null
  const previewImageUrl = source?.imageUrl ?? null
  const previewMimeType = source?.mimeType ?? null
  const previewRelativePath = source?.relativePath ?? null
  const previewContainer = source?.container ?? null
  const previewVideoCodec = source?.videoCodec ?? null
  const previewAudioCodec = source?.audioCodec ?? null
  const previewDuration = source?.duration ?? 0
  const previewStartTime = hoverStartTime(source)
  const classifiedMode = useMemo(
    () =>
      hoverPreviewMode(
        previewFileId
          ? {
              mediaKind: previewMediaKind ?? 'video',
              fileId: previewFileId,
              imageUrl: previewImageUrl,
              mimeType: previewMimeType,
              relativePath: previewRelativePath,
              container: previewContainer,
              videoCodec: previewVideoCodec,
              audioCodec: previewAudioCodec,
              duration: previewDuration,
            }
          : null,
      ),
    [
      previewAudioCodec,
      previewContainer,
      previewDuration,
      previewFileId,
      previewImageUrl,
      previewMediaKind,
      previewMimeType,
      previewRelativePath,
      previewVideoCodec,
    ],
  )
  const [failedDirectFileId, setFailedDirectFileId] = useState<string | null>(null)
  const mode =
    classifiedMode === 'direct' && failedDirectFileId === previewFileId
      ? 'storyboard'
      : classifiedMode
  const [active, setActive] = useState(false)
  const [phase, setPhase] = useState<HoverPreviewPhase>('playing')
  const [pointerInside, setPointerInside] = useState(false)
  const [prefetchStoryboard, setPrefetchStoryboard] = useState(false)
  const [muted, setMuted] = useState(true)
  const [position, setPosition] = useState(0)
  const token = useRef(Symbol('hover-preview'))
  const dwellTimer = useRef<number | null>(null)
  const prefetchTimer = useRef<number | null>(null)
  const restTimer = useRef<number | null>(null)
  const metadataReadyTimer = useRef<number | null>(null)
  const seekReadyTimer = useRef<number | null>(null)
  const frameReadyTimer = useRef<number | null>(null)
  const playbackTimer = useRef<number | null>(null)
  const seekListenerCleanup = useRef<(() => void) | null>(null)
  const videoFrameWait = useRef<{ element: HTMLVideoElement; id: number } | null>(null)
  const animationFrameWait = useRef<number | null>(null)
  const resumeGeneration = useRef(0)
  const restPosition = useRef(0)
  const storyboardUnavailable = useRef(false)

  useEffect(() => {
    storyboardUnavailable.current = false
  }, [previewFileId])

  const clearSeekWait = useCallback(() => {
    if (metadataReadyTimer.current !== null) window.clearTimeout(metadataReadyTimer.current)
    if (seekReadyTimer.current !== null) window.clearTimeout(seekReadyTimer.current)
    metadataReadyTimer.current = null
    seekReadyTimer.current = null
    seekListenerCleanup.current?.()
    seekListenerCleanup.current = null
  }, [])

  const clearPresentedFrameWait = useCallback(() => {
    if (frameReadyTimer.current !== null) {
      window.clearTimeout(frameReadyTimer.current)
      frameReadyTimer.current = null
    }
    if (videoFrameWait.current !== null) {
      videoFrameWait.current.element.cancelVideoFrameCallback?.(videoFrameWait.current.id)
      videoFrameWait.current = null
    }
    if (animationFrameWait.current !== null) {
      window.cancelAnimationFrame(animationFrameWait.current)
      animationFrameWait.current = null
    }
    if (playbackTimer.current !== null) {
      window.clearTimeout(playbackTimer.current)
      playbackTimer.current = null
    }
  }, [])

  const cancelPendingResume = useCallback(() => {
    resumeGeneration.current += 1
    clearSeekWait()
    clearPresentedFrameWait()
  }, [clearPresentedFrameWait, clearSeekWait])

  const clearTimers = useCallback(() => {
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current)
    if (prefetchTimer.current !== null) window.clearTimeout(prefetchTimer.current)
    if (restTimer.current !== null) window.clearTimeout(restTimer.current)
    dwellTimer.current = null
    prefetchTimer.current = null
    restTimer.current = null
    cancelPendingResume()
  }, [cancelPendingResume])

  const deactivate = useCallback(() => {
    clearTimers()
    if (currentOwner?.token === token.current) currentOwner = null
    setActive(false)
    setPhase('playing')
    setPrefetchStoryboard(false)
    setMuted(true)
    setPosition(0)
  }, [clearTimers])

  const canActivate = useCallback(
    () =>
      Boolean(previewFileId) &&
      !disabled &&
      mode !== 'none' &&
      !storyboardUnavailable.current &&
      hasFineHover(),
    [disabled, mode, previewFileId],
  )

  const activate = useCallback(() => {
    dwellTimer.current = null
    if (!canActivate() || currentOwner?.token === token.current) return
    if (currentOwner?.token !== token.current) currentOwner?.stop()
    currentOwner = { token: token.current, stop: deactivate }
    restPosition.current = previewStartTime
    setPosition(previewStartTime)
    setPhase(mode === 'direct' ? 'transitioning' : 'playing')
    setMuted(true)
    setActive(true)
  }, [canActivate, deactivate, mode, previewStartTime])

  const startDwell = useCallback(() => {
    if (!canActivate() || currentOwner?.token === token.current) return
    if (dwellTimer.current !== null) window.clearTimeout(dwellTimer.current)
    const timer = window.setTimeout(() => {
      if (dwellTimer.current !== timer) return
      activate()
    }, HOVER_PREVIEW_DWELL_MS)
    dwellTimer.current = timer
  }, [activate, canActivate])

  useEffect(() => {
    if (canActivate()) {
      if (pointerInside && !active) startDwell()
      return
    }
    // External menu/drag state must tear media down in the same turn
    // eslint-disable-next-line react-hooks/set-state-in-effect
    deactivate()
  }, [active, canActivate, deactivate, pointerInside, startDwell])

  useEffect(() => deactivate, [deactivate])

  const onPointerEnter = useCallback(() => {
    storyboardUnavailable.current = false
    clearTimers()
    setPointerInside(true)
    setPrefetchStoryboard(false)
    if (canActivate()) startDwell()
    if (canActivate() && mode !== 'image') {
      prefetchTimer.current = window.setTimeout(() => {
        prefetchTimer.current = null
        setPrefetchStoryboard(true)
      }, HOVER_PREVIEW_PREFETCH_MS)
    }
  }, [canActivate, clearTimers, mode, startDwell])

  const fallbackToStoryboard = useCallback(() => {
    if (!previewFileId) {
      deactivate()
      return
    }
    setFailedDirectFileId(previewFileId)
  }, [deactivate, previewFileId])

  const revealPresentedFrame = useCallback(
    (element: HTMLVideoElement, generation: number) => {
      clearPresentedFrameWait()
      const reveal = () => {
        videoFrameWait.current = null
        animationFrameWait.current = null
        if (generation === resumeGeneration.current) setPhase('playing')
      }
      if (typeof element.requestVideoFrameCallback === 'function') {
        const id = element.requestVideoFrameCallback(reveal)
        videoFrameWait.current = { element, id }
        return
      }
      animationFrameWait.current = window.requestAnimationFrame(() => {
        animationFrameWait.current = window.requestAnimationFrame(reveal)
      })
    },
    [clearPresentedFrameWait],
  )

  const playVideo = useCallback(
    async (element: HTMLVideoElement, generation: number) => {
      const originallyMuted = element.muted
      try {
        await element.play()
      } catch (error) {
        if (generation !== resumeGeneration.current) return
        const errorName =
          typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : ''
        if (originallyMuted || (errorName !== 'NotAllowedError' && errorName !== 'AbortError')) {
          fallbackToStoryboard()
          return
        }
        element.muted = true
        try {
          await element.play()
        } catch {
          if (generation === resumeGeneration.current) fallbackToStoryboard()
          return
        }
        if (generation === resumeGeneration.current) element.muted = false
      }
      return generation === resumeGeneration.current
    },
    [fallbackToStoryboard],
  )

  const playAfterSeek = useCallback(
    async (element: HTMLVideoElement, generation: number) => {
      if (await playVideo(element, generation)) revealPresentedFrame(element, generation)
    },
    [playVideo, revealPresentedFrame],
  )

  const armMediaSeek = useCallback(
    (element: HTMLVideoElement, target: number, generation: number, callbacks: SeekCallbacks) => {
      let armed = false
      let seekReady = false
      let metadataListener: (() => void) | null = null
      let seekedListener: (() => void) | null = null
      seekListenerCleanup.current = () => {
        if (metadataListener) element.removeEventListener('loadedmetadata', metadataListener)
        if (seekedListener) element.removeEventListener('seeked', seekedListener)
      }
      const markSeekReady = () => {
        if (
          seekReady ||
          generation !== resumeGeneration.current ||
          element.seeking ||
          Math.abs(element.currentTime - target) > SEEK_TIME_TOLERANCE_S
        ) {
          return
        }
        seekReady = true
        clearSeekWait()
        callbacks.onReady()
      }
      const armSeek = () => {
        if (armed || generation !== resumeGeneration.current) return
        armed = true
        if (metadataReadyTimer.current !== null) {
          window.clearTimeout(metadataReadyTimer.current)
          metadataReadyTimer.current = null
        }
        const needsSeek = Math.abs(element.currentTime - target) > SEEK_TIME_TOLERANCE_S
        seekedListener = markSeekReady
        element.addEventListener('seeked', seekedListener)
        callbacks.beforeSeek?.(needsSeek)
        const checkReady = () => {
          if (generation !== resumeGeneration.current) return
          markSeekReady()
          if (seekReady) return
          seekReadyTimer.current = window.setTimeout(checkReady, SEEK_READY_CHECK_MS)
        }
        seekReadyTimer.current = window.setTimeout(checkReady, SEEK_READY_CHECK_MS)
        if (needsSeek) element.currentTime = target
        else window.queueMicrotask(markSeekReady)
      }
      if (target > 0 && element.readyState === 0) {
        metadataListener = armSeek
        element.addEventListener('loadedmetadata', metadataListener)
        metadataReadyTimer.current = window.setTimeout(() => {
          metadataReadyTimer.current = null
          if (generation !== resumeGeneration.current) return
          clearSeekWait()
          fallbackToStoryboard()
        }, METADATA_READY_TIMEOUT_MS)
        return
      }
      armSeek()
    },
    [clearSeekWait, fallbackToStoryboard],
  )

  const seekThenPlayImmediately = useCallback(
    (element: HTMLVideoElement, target: number, generation: number) => {
      armMediaSeek(element, target, generation, {
        onReady: () => void playAfterSeek(element, generation),
      })
    },
    [armMediaSeek, playAfterSeek],
  )

  const seekThenAlignReveal = useCallback(
    (element: HTMLVideoElement, target: number, generation: number) => {
      let playbackStarted = false
      let seekReady = false
      let frameReady = false
      const startPlayback = () => {
        if (
          playbackStarted ||
          !seekReady ||
          !frameReady ||
          generation !== resumeGeneration.current
        ) {
          return
        }
        playbackStarted = true
        clearPresentedFrameWait()
        animationFrameWait.current = window.requestAnimationFrame(() => {
          animationFrameWait.current = null
          if (generation !== resumeGeneration.current) return
          // Paint the paused target before playback can advance it
          flushSync(() => setPhase('playing'))
          playbackTimer.current = window.setTimeout(() => {
            playbackTimer.current = null
            if (generation !== resumeGeneration.current) return
            void playVideo(element, generation)
          }, 0)
        })
      }
      const markSeekReady = () => {
        if (seekReady || generation !== resumeGeneration.current) return
        seekReady = true
        if (!frameReady && frameReadyTimer.current === null) {
          frameReadyTimer.current = window.setTimeout(() => {
            frameReadyTimer.current = null
            frameReady = true
            startPlayback()
          }, FRAME_PRESENT_FALLBACK_MS)
        }
        startPlayback()
      }
      const armPresentedFrame = (needsSeek: boolean) => {
        if (!needsSeek || typeof element.requestVideoFrameCallback !== 'function') {
          frameReady = true
          return
        }
        const framePresented: VideoFrameRequestCallback = (_now, metadata) => {
          videoFrameWait.current = null
          if (generation !== resumeGeneration.current) return
          if (
            Number.isFinite(metadata.mediaTime) &&
            Math.abs(metadata.mediaTime - target) > FRAME_TIME_TOLERANCE_S
          ) {
            const id = element.requestVideoFrameCallback(framePresented)
            videoFrameWait.current = { element, id }
            return
          }
          if (frameReadyTimer.current !== null) window.clearTimeout(frameReadyTimer.current)
          frameReadyTimer.current = null
          frameReady = true
          startPlayback()
        }
        const id = element.requestVideoFrameCallback(framePresented)
        videoFrameWait.current = { element, id }
      }
      armMediaSeek(element, target, generation, {
        beforeSeek: armPresentedFrame,
        onReady: markSeekReady,
      })
    },
    [armMediaSeek, clearPresentedFrameWait, playVideo],
  )

  const resumeAtRest = useCallback(() => {
    restTimer.current = null
    if (!active) return
    if (mode !== 'direct') {
      setPhase('playing')
      return
    }
    const element = videoRef.current
    if (!element) return
    cancelPendingResume()
    const generation = resumeGeneration.current
    const cursorTarget = restPosition.current
    const storyboardTarget = storyboardTimeForPosition?.(cursorTarget) ?? null
    const duration = source?.duration ?? 0
    const target =
      source && storyboardTarget !== null && Number.isFinite(storyboardTarget)
        ? Math.max(0, Math.min(duration, storyboardTarget))
        : cursorTarget
    flushSync(() => {
      setPosition(target)
      setPhase('transitioning')
    })
    if (storyboardTarget !== null) seekThenAlignReveal(element, target, generation)
    else seekThenPlayImmediately(element, target, generation)
  }, [
    active,
    cancelPendingResume,
    mode,
    seekThenAlignReveal,
    seekThenPlayImmediately,
    source,
    storyboardTimeForPosition,
    videoRef,
  ])

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!active || !source || source.mediaKind !== 'video') return
      const time = hoverTimeForPointer(
        event.clientX,
        event.currentTarget.getBoundingClientRect(),
        source.duration ?? 0,
      )
      restPosition.current = time
      setPosition(time)
      setPhase('skimming')
      if (mode === 'direct') {
        cancelPendingResume()
        videoRef.current?.pause()
      }
      if (restTimer.current !== null) window.clearTimeout(restTimer.current)
      const timer = window.setTimeout(() => {
        if (restTimer.current !== timer) return
        resumeAtRest()
      }, HOVER_PREVIEW_REST_MS)
      restTimer.current = timer
    },
    [active, cancelPendingResume, mode, resumeAtRest, source, videoRef],
  )

  const onPointerLeave = useCallback(() => {
    setPointerInside(false)
    storyboardUnavailable.current = false
    deactivate()
  }, [deactivate])

  const onContextMenuCapture = useCallback(() => {
    deactivate()
  }, [deactivate])

  const onDragStartCapture = useCallback(() => {
    deactivate()
  }, [deactivate])

  const giveUpStoryboard = useCallback(() => {
    storyboardUnavailable.current = true
    deactivate()
  }, [deactivate])

  const toggleMuted = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const element = videoRef.current
      if (!element) return
      element.muted = !element.muted
      setMuted(element.muted)
    },
    [videoRef],
  )

  const onTimeUpdate = useCallback(
    (event: React.SyntheticEvent<HTMLVideoElement>) => {
      if (phase === 'playing') setPosition(event.currentTarget.currentTime)
    },
    [phase],
  )

  useEffect(() => {
    if (!active || mode !== 'direct') return
    const element = videoRef.current
    if (!element) return
    element.muted = true
    cancelPendingResume()
    const generation = resumeGeneration.current
    seekThenPlayImmediately(element, previewStartTime, generation)
    return () => {
      cancelPendingResume()
      element.pause()
      element.removeAttribute('src')
      element.load()
    }
  }, [active, cancelPendingResume, mode, previewStartTime, seekThenPlayImmediately, videoRef])

  return {
    active,
    phase,
    mode,
    muted,
    position,
    prefetchStoryboard,
    deactivate,
    fallbackToStoryboard,
    giveUpStoryboard,
    toggleMuted,
    onTimeUpdate,
    bind: {
      onPointerEnter,
      onPointerMove,
      onPointerLeave,
      onContextMenuCapture,
      onDragStartCapture,
    },
  }
}
