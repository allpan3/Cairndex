import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import {
  isDesktopHost,
  isHostWindowFullscreen,
  listenHostFullscreen,
  toggleHostWindowFullscreen,
} from '../../../platform'
import {
  createLeadingTrailingThrottle,
  type LeadingTrailingThrottle,
} from '../../../lib/leadingTrailingThrottle'
import type { PlayerPrefs } from '../../types'
import { createEngine, type PlaybackEngine, type PlaybackSource } from './engine'

// Auto-repeat on an arrow key fires far faster than a media element can start a
// new byte range. Matches the drag throttle in `SeekBar`.
const RELATIVE_SEEK_THROTTLE_MS = 150

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface BufferedRange {
  start: number
  end: number
}

export interface PlayerController {
  status: PlayerStatus
  wantsPlayback: boolean
  paused: boolean
  buffering: boolean
  currentTime: number
  duration: number
  buffered: BufferedRange[]
  volume: number
  muted: boolean
  rate: number
  seekStep: PlayerPrefs['seekStep']
  preservesPitch: boolean
  fullscreen: boolean
  pip: boolean
  subtitlesOn: boolean
  playPause: () => void
  play: () => void
  pause: () => void
  seek: (time: number) => void
  seekBy: (delta: number) => void
  setVolume: (volume: number) => void
  setMuted: (muted: boolean) => void
  setRate: (rate: number) => void
  setSeekStep: (step: 2 | 5 | 10 | 30) => void
  setPreservesPitch: (enabled: boolean) => void
  toggleSubtitles: () => void
  toggleFullscreen: () => void
  togglePiP: () => void
  frameStep: (delta: number) => void
}

export interface PlayerBindings {
  player: PlayerController
  videoRef: (element: HTMLVideoElement | null) => void
  videoElement: HTMLVideoElement | null
}

interface UsePlayerOptions {
  source: PlaybackSource | null
  mediaKey?: string | null
  expectedDuration?: number | null
  rootRef: React.RefObject<HTMLElement | null>
  prefs: PlayerPrefs
  onPrefs: Dispatch<SetStateAction<PlayerPrefs>>
  resumePosition?: number | null
  resumeCompleted?: boolean
  onResumed?: (position: number) => void
}

/** Headless native-video state and commands for the M2 custom controls. */
export function usePlayer({
  source,
  mediaKey = null,
  expectedDuration = null,
  rootRef,
  prefs,
  onPrefs,
  resumePosition = null,
  resumeCompleted = false,
  onResumed,
}: UsePlayerOptions): PlayerBindings {
  const engineRef = useRef<PlaybackEngine | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const prefsRef = useRef(prefs)
  const onPrefsRef = useRef(onPrefs)
  const resumeRef = useRef({ position: resumePosition, completed: resumeCompleted, onResumed })
  const resumedSourceRef = useRef<string | null>(null)
  const [videoElement, setVideoElementState] = useState<HTMLVideoElement | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [wantsPlayback, setWantsPlayback] = useState(true)
  const intentRef = useRef(true)
  const playRequest = useRef(0)
  const [paused, setPaused] = useState(true)
  const [buffering, setBuffering] = useState(false)
  const [observedSource, setObservedSource] = useState(source)

  // Latest accumulated relative-seek target, and the throttle that commits it.
  const pendingSeek = useRef<number | null>(null)
  const relativeSeek = useRef<LeadingTrailingThrottle<number> | null>(null)
  const queuedSeek = useRef<number | null>(null)

  // A new media selection starts playback; replacing its transport preserves the last action
  useEffect(() => {
    intentRef.current = true
    queuedSeek.current = null
    playRequest.current += 1
    // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronize the selected media identity
    setWantsPlayback(true)
  }, [mediaKey])
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<BufferedRange[]>([])
  const [fullscreen, setFullscreen] = useState(false)
  const [pip, setPip] = useState(false)

  useEffect(() => {
    prefsRef.current = prefs
    onPrefsRef.current = onPrefs
  }, [onPrefs, prefs])

  useEffect(() => {
    resumeRef.current = { position: resumePosition, completed: resumeCompleted, onResumed }
  }, [onResumed, resumeCompleted, resumePosition])

  useEffect(() => {
    resumedSourceRef.current = null
    pendingSeek.current = null
    relativeSeek.current?.cancel()
    playRequest.current += 1
    if (videoRef.current) videoRef.current.currentTime = 0
    /* eslint-disable react-hooks/set-state-in-effect */
    setObservedSource(source)
    setPaused(true)
    setBuffering(Boolean(source))
    setCurrentTime(0)
    setDuration(0)
    setBuffered([])
    setStatus(source ? 'loading' : 'idle')
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [source])

  const videoRefCallback = useCallback((element: HTMLVideoElement | null) => {
    videoRef.current = element
    setVideoElementState(element)
  }, [])

  useEffect(() => {
    const throttle = createLeadingTrailingThrottle(RELATIVE_SEEK_THROTTLE_MS, (time: number) => {
      pendingSeek.current = null
      const video = videoRef.current
      if (!engineRef.current || !video || !Number.isFinite(video.duration) || video.duration <= 0)
        queuedSeek.current = time
      else engineRef.current.seek(time)
    })
    relativeSeek.current = throttle
    return () => {
      throttle.cancel()
      relativeSeek.current = null
    }
  }, [])

  const syncBuffered = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const ranges: BufferedRange[] = []
    for (let i = 0; i < video.buffered.length; i += 1) {
      ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) })
    }
    setBuffered((previous) =>
      previous.length === ranges.length &&
      previous.every((range, i) => range.start === ranges[i]?.start && range.end === ranges[i]?.end)
        ? previous
        : ranges,
    )
  }, [])

  // Only the current engine and latest command may settle an asynchronous play attempt
  const requestPlay = useCallback((engine: PlaybackEngine) => {
    const request = ++playRequest.current
    void engine.play().catch((error: unknown) => {
      if (engineRef.current !== engine || request !== playRequest.current || !intentRef.current)
        return
      // A seek can interrupt play; canplay/seeked will retry without erasing intent
      if (error instanceof DOMException && error.name === 'AbortError') return
      intentRef.current = false
      setWantsPlayback(false)
      setPaused(true)
      setBuffering(false)
      setStatus('paused')
    })
  }, [])

  useEffect(() => {
    if (!videoElement || !source) {
      engineRef.current = null
      return
    }
    const engine = createEngine(videoElement, source)
    const initialPrefs = prefsRef.current
    engineRef.current = engine
    engine.setVolume(initialPrefs.volume)
    engine.setMuted(initialPrefs.muted)
    engine.setRate(initialPrefs.rate)
    engine.setPreservesPitch(initialPrefs.preservesPitch)
    engine.load(source)
    if (intentRef.current) requestPlay(engine)
    return () => {
      if (engineRef.current === engine) engineRef.current = null
      playRequest.current += 1
      engine.destroy()
    }
  }, [source, videoElement, requestPlay])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !videoElement) return
    engine.setVolume(prefs.volume)
    engine.setMuted(prefs.muted)
    engine.setRate(prefs.rate)
    engine.setPreservesPitch(prefs.preservesPitch)
  }, [prefs.muted, prefs.preservesPitch, prefs.rate, prefs.volume, videoElement])

  useEffect(() => {
    const engine = engineRef.current
    const video = videoElement
    if (!engine || !video) return
    const onLoaded = () => {
      const knownDuration = source?.kind === 'hls' ? expectedDuration : null
      setDuration(
        knownDuration && Number.isFinite(knownDuration) && knownDuration > 0
          ? knownDuration
          : Number.isFinite(video.duration)
            ? video.duration
            : 0,
      )
      syncBuffered()
      if (!Number.isFinite(video.duration) || video.duration <= 0) return
      if (!source || resumedSourceRef.current === source.src) return
      if (queuedSeek.current !== null) {
        const time = queuedSeek.current
        queuedSeek.current = null
        engine.seek(time)
        setCurrentTime(time)
        resumedSourceRef.current = source.src
        return
      }
      // An explicit startAt (quality/audio switch or transparent re-attach) wins
      // over resume progress — the new stream must pick up at the live playhead.
      const startAt = source.startAt
      if (typeof startAt === 'number' && Number.isFinite(startAt) && startAt >= 0) {
        engine.seek(startAt)
        setCurrentTime(startAt)
        resumedSourceRef.current = source.src
        if (startAt > 0 && startAt === resumeRef.current.position && !resumeRef.current.completed)
          resumeRef.current.onResumed?.(startAt)
        return
      }
      resumedSourceRef.current = source.src
      const resume = resumeRef.current
      const position = resume.position ?? 0
      if (!resume.completed && position > 0) {
        engine.seek(position)
        setCurrentTime(position)
        resumedSourceRef.current = source.src
        resume.onResumed?.(position)
      }
    }
    const onTime = () => setCurrentTime(video.currentTime)
    const onPlay = () => {
      if (!intentRef.current) {
        engine.pause()
        return
      }
      setPaused(video.paused)
      setBuffering(false)
      setStatus('playing')
    }
    const onPause = () => {
      setPaused(true)
      setStatus('paused')
    }
    const onEnded = () => {
      // A truncated native HLS timeline is a session failure, never a playlist advance
      if (
        source?.kind === 'hls' &&
        expectedDuration &&
        Number.isFinite(expectedDuration) &&
        video.currentTime < expectedDuration - 2
      ) {
        video.dispatchEvent(new CustomEvent('error', { detail: 'session' }))
        return
      }
      intentRef.current = false
      setWantsPlayback(false)
      setPaused(true)
      setBuffering(false)
      setStatus('ended')
    }
    const onWaiting = () => {
      setBuffering(true)
      setStatus(intentRef.current ? 'loading' : 'paused')
    }
    const onReady = () => {
      setBuffering(false)
      if (intentRef.current && video.paused && !video.ended) requestPlay(engine)
      else if (!intentRef.current && !video.paused) engine.pause()
    }
    const onError = () => {
      setBuffering(false)
      setStatus('error')
    }
    // Teardown events from an abandoned engine cannot alter the replacement source
    const listen = (event: Parameters<PlaybackEngine['on']>[0], callback: () => void) =>
      engine.on(event, () => {
        if (engineRef.current === engine) callback()
      })
    const off = [
      listen('loadedmetadata', onLoaded),
      listen('durationchange', onLoaded),
      listen('progress', syncBuffered),
      listen('timeupdate', onTime),
      listen('play', onPlay),
      listen('playing', onPlay),
      listen('pause', onPause),
      listen('ended', onEnded),
      listen('waiting', onWaiting),
      listen('seeking', onWaiting),
      listen('canplay', onReady),
      listen('seeked', onReady),
      listen('error', onError),
      listen('enterpictureinpicture', () => setPip(true)),
      listen('leavepictureinpicture', () => setPip(false)),
    ]
    onLoaded()
    onTime()
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [source, expectedDuration, syncBuffered, videoElement, requestPlay])

  useEffect(() => {
    // In the shell the viewer uses real window fullscreen (see toggleFullscreen),
    // so track the window rather than the HTML Fullscreen API — including changes
    // made from the native View menu, which never touches the DOM.
    if (isDesktopHost()) {
      let disposed = false
      let unlisten: (() => void) | undefined
      // The initial query and the subscription are independent async channels. If
      // an event lands first, the older query's result is stale by the time it
      // resolves and must not overwrite it.
      let sawEvent = false
      void isHostWindowFullscreen()
        .then((active) => {
          if (!disposed && !sawEvent) setFullscreen(active)
        })
        .catch(() => undefined)
      void listenHostFullscreen((active) => {
        sawEvent = true
        setFullscreen(active)
      })
        .then((stop) => {
          if (disposed) stop()
          else unlisten = stop
        })
        .catch(() => undefined)
      return () => {
        disposed = true
        unlisten?.()
      }
    }
    const onFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [rootRef])

  const updatePrefs = useCallback((updater: (previous: PlayerPrefs) => PlayerPrefs) => {
    onPrefsRef.current((previous) => updater(previous))
  }, [])

  const play = useCallback(() => {
    intentRef.current = true
    setWantsPlayback(true)
    const engine = engineRef.current
    if (engine) requestPlay(engine)
  }, [requestPlay])

  const pause = useCallback(() => {
    intentRef.current = false
    playRequest.current += 1
    setWantsPlayback(false)
    setStatus('paused')
    engineRef.current?.pause()
  }, [])

  const playPause = useCallback(() => {
    if (intentRef.current) pause()
    else play()
  }, [pause, play])

  const clampTime = useCallback((time: number) => {
    const limit = videoRef.current?.duration ?? 0
    return Math.max(0, Math.min(time, limit || time))
  }, [])

  const seek = useCallback(
    (time: number) => {
      pendingSeek.current = null
      relativeSeek.current?.cancel()
      const target = clampTime(time)
      const video = videoRef.current
      if (!engineRef.current || !video || !Number.isFinite(video.duration) || video.duration <= 0)
        queuedSeek.current = target
      else engineRef.current.seek(target)
      setCurrentTime(target)
    },
    [clampTime],
  )

  // Relative seeking is the auto-repeat path: holding an arrow key emits ~30
  // keydowns a second, and every `currentTime` write aborts the in-flight byte
  // range and opens a new one — punishing on a 25 Mbps 4K source. Accumulate
  // the deltas so a held key still travels the same distance, show the moving
  // target immediately, and let the element see one seek per window. The drag
  // path has had this since it shipped (`SeekBar`); the keyboard never did.
  const seekBy = useCallback(
    (delta: number) => {
      const from = pendingSeek.current ?? queuedSeek.current ?? videoRef.current?.currentTime ?? 0
      const target = clampTime(from + delta)
      pendingSeek.current = target
      setCurrentTime(target)
      relativeSeek.current?.schedule(target)
    },
    [clampTime],
  )

  const setVolume = useCallback(
    (volume: number) => {
      const next = Math.max(0, Math.min(1, volume))
      const muted = next === 0
      engineRef.current?.setVolume(next)
      engineRef.current?.setMuted(muted)
      updatePrefs((previous) => ({ ...previous, volume: next, muted }))
    },
    [updatePrefs],
  )

  const setMuted = useCallback(
    (muted: boolean) => {
      engineRef.current?.setMuted(muted)
      updatePrefs((previous) => ({ ...previous, muted }))
    },
    [updatePrefs],
  )

  const setRate = useCallback(
    (rate: number) => {
      const next = Math.max(0.25, Math.min(3, rate))
      engineRef.current?.setRate(next)
      updatePrefs((previous) => ({ ...previous, rate: next }))
    },
    [updatePrefs],
  )

  const setSeekStep = useCallback(
    (seekStep: 2 | 5 | 10 | 30) => updatePrefs((previous) => ({ ...previous, seekStep })),
    [updatePrefs],
  )

  const setPreservesPitch = useCallback(
    (preservesPitch: boolean) => {
      engineRef.current?.setPreservesPitch(preservesPitch)
      updatePrefs((previous) => ({ ...previous, preservesPitch }))
    },
    [updatePrefs],
  )

  const toggleSubtitles = useCallback(() => {
    updatePrefs((previous) => ({ ...previous, subtitlesOn: !previous.subtitlesOn }))
  }, [updatePrefs])

  const toggleFullscreen = useCallback(() => {
    // The viewer is already a full-window overlay, so in the shell real window
    // fullscreen is the correct "proper viewer fullscreen" (plan 3 §7) and it
    // sidesteps WKWebView's user-activation requirement on requestFullscreen,
    // which a native menu item cannot satisfy (D1 audit).
    // The toggle is atomic in Rust; reading then setting over two IPC round trips
    // would let two fast presses both observe the same pre-toggle state.
    if (isDesktopHost()) {
      void toggleHostWindowFullscreen().catch(() => undefined)
      return
    }
    const root = rootRef.current
    if (!root) return
    if (document.fullscreenElement === root) void document.exitFullscreen()
    else void root.requestFullscreen?.()
  }, [rootRef])

  const togglePiP = useCallback(() => {
    const video = videoRef.current
    if (!video || !document.pictureInPictureEnabled) return
    if (document.pictureInPictureElement === video) void document.exitPictureInPicture?.()
    else void video.requestPictureInPicture?.()
  }, [])

  const frameStep = useCallback(
    (delta: number) => {
      pause()
      seekBy(delta / 30)
    },
    [pause, seekBy],
  )

  const player = useMemo<PlayerController>(() => {
    const active = Boolean(source && source === observedSource && videoElement)
    return {
      status: active ? (status === 'idle' ? 'loading' : status) : source ? 'loading' : 'idle',
      wantsPlayback,
      paused: active ? paused : true,
      buffering: active ? buffering : Boolean(source),
      currentTime: active ? currentTime : 0,
      duration: active ? duration : 0,
      buffered: active ? buffered : [],
      volume: prefs.volume,
      muted: prefs.muted,
      rate: prefs.rate,
      seekStep: prefs.seekStep,
      preservesPitch: prefs.preservesPitch,
      fullscreen,
      pip,
      subtitlesOn: prefs.subtitlesOn,
      playPause,
      play,
      pause,
      seek,
      seekBy,
      setVolume,
      setMuted,
      setRate,
      setSeekStep,
      setPreservesPitch,
      toggleSubtitles,
      toggleFullscreen,
      togglePiP,
      frameStep,
    }
  }, [
    status,
    wantsPlayback,
    paused,
    buffering,
    observedSource,
    currentTime,
    duration,
    buffered,
    source,
    prefs.volume,
    prefs.muted,
    prefs.rate,
    prefs.seekStep,
    prefs.preservesPitch,
    prefs.subtitlesOn,
    fullscreen,
    pip,
    videoElement,
    playPause,
    play,
    pause,
    seek,
    seekBy,
    setVolume,
    setMuted,
    setRate,
    setSeekStep,
    setPreservesPitch,
    toggleSubtitles,
    toggleFullscreen,
    togglePiP,
    frameStep,
  ])
  return useMemo(
    () => ({ player, videoRef: videoRefCallback, videoElement }),
    [player, videoElement, videoRefCallback],
  )
}
