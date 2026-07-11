import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react'

import type { PlayerPrefs } from '../../types'
import { createEngine, type PlaybackEngine, type PlaybackSource } from './engine'

export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error'

export interface BufferedRange {
  start: number
  end: number
}

export interface PlayerController {
  status: PlayerStatus
  currentTime: number
  duration: number
  buffered: BufferedRange[]
  volume: number
  muted: boolean
  rate: number
  seekStep: number
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
    if (videoRef.current) videoRef.current.currentTime = 0
    /* eslint-disable react-hooks/set-state-in-effect */
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

  const syncBuffered = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const ranges: BufferedRange[] = []
    for (let i = 0; i < video.buffered.length; i += 1) {
      ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) })
    }
    setBuffered(ranges)
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
    void engine.play().catch(() => setStatus('paused'))
    return () => {
      engine.destroy()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [source, videoElement])

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
      setDuration(Number.isFinite(video.duration) ? video.duration : 0)
      syncBuffered()
      if (!source || resumedSourceRef.current === source.src) return
      // An explicit startAt (quality/audio switch or transparent re-attach) wins
      // over resume progress — the new stream must pick up at the live playhead.
      const startAt = source.startAt
      if (typeof startAt === 'number' && Number.isFinite(startAt) && startAt > 0) {
        engine.seek(startAt)
        setCurrentTime(startAt)
        resumedSourceRef.current = source.src
        return
      }
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
    const onPlay = () => setStatus('playing')
    const onPause = () => setStatus(video.ended ? 'ended' : 'paused')
    const onEnded = () => setStatus('ended')
    const onWaiting = () => setStatus((s) => (s === 'playing' ? 'loading' : s))
    const onError = () => setStatus('error')
    const off = [
      engine.on('loadedmetadata', onLoaded),
      engine.on('durationchange', onLoaded),
      engine.on('progress', syncBuffered),
      engine.on('timeupdate', onTime),
      engine.on('play', onPlay),
      engine.on('playing', onPlay),
      engine.on('pause', onPause),
      engine.on('ended', onEnded),
      engine.on('waiting', onWaiting),
      engine.on('error', onError),
      engine.on('enterpictureinpicture', () => setPip(true)),
      engine.on('leavepictureinpicture', () => setPip(false)),
    ]
    onLoaded()
    onTime()
    return () => off.forEach((unsubscribe) => unsubscribe())
  }, [source, syncBuffered, videoElement])

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [rootRef])

  const updatePrefs = useCallback((updater: (previous: PlayerPrefs) => PlayerPrefs) => {
    onPrefsRef.current((previous) => updater(previous))
  }, [])

  const play = useCallback(() => {
    void engineRef.current?.play().catch(() => setStatus('paused'))
  }, [])

  const pause = useCallback(() => {
    engineRef.current?.pause()
  }, [])

  const playPause = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused || video.ended) play()
    else pause()
  }, [pause, play])

  const seek = useCallback((time: number) => {
    engineRef.current?.seek(time)
    const live = videoRef.current
    const limit = live?.duration ?? 0
    setCurrentTime(Math.max(0, Math.min(time, limit || time)))
  }, [])

  const seekBy = useCallback(
    (delta: number) => {
      seek((videoRef.current?.currentTime ?? 0) + delta)
    },
    [seek],
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
      seek((videoRef.current?.currentTime ?? 0) + delta / 30)
    },
    [pause, seek],
  )

  const player = useMemo<PlayerController>(() => {
    const active = Boolean(source && videoElement)
    return {
      status: active ? (status === 'idle' ? 'loading' : status) : 'idle',
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
