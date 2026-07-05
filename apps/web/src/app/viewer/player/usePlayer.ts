import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { PlayerPrefs } from '../../types'
import { NativeEngine, type PlaybackSource } from './engine'

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
  toggleSubtitles: () => void
  setSubtitlesOn: (enabled: boolean) => void
  toggleFullscreen: () => void
  togglePiP: () => void
  frameStep: (delta: number) => void
}

interface UsePlayerOptions {
  videoRef: React.RefObject<HTMLVideoElement | null>
  source: PlaybackSource | null
  rootRef: React.RefObject<HTMLElement | null>
  prefs: PlayerPrefs
  onPrefs: (prefs: PlayerPrefs) => void
}

/** Headless native-video state and commands for the M2 custom controls. */
export function usePlayer({
  videoRef,
  source,
  rootRef,
  prefs,
  onPrefs,
}: UsePlayerOptions): PlayerController {
  const engineRef = useRef<NativeEngine | null>(null)
  const [status, setStatus] = useState<PlayerStatus>('idle')
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [buffered, setBuffered] = useState<BufferedRange[]>([])
  const [fullscreen, setFullscreen] = useState(false)
  const [pip, setPip] = useState(false)

  const syncBuffered = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    const ranges: BufferedRange[] = []
    for (let i = 0; i < video.buffered.length; i += 1) {
      ranges.push({ start: video.buffered.start(i), end: video.buffered.end(i) })
    }
    setBuffered(ranges)
  }, [videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video || !source) return
    const engine = new NativeEngine(video)
    engineRef.current = engine
    setStatus('loading')
    setCurrentTime(0)
    setDuration(0)
    engine.load(source)
    void engine.play().catch(() => setStatus('paused'))
    return () => {
      engine.destroy()
      if (engineRef.current === engine) engineRef.current = null
    }
  }, [videoRef, source])

  useEffect(() => {
    const engine = engineRef.current
    const video = videoRef.current
    if (!engine || !video) return
    engine.setVolume(prefs.volume)
    engine.setMuted(prefs.muted)
    engine.setRate(prefs.rate)
  }, [prefs.muted, prefs.rate, prefs.volume, videoRef])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const onLoaded = () => {
      setDuration(Number.isFinite(video.duration) ? video.duration : 0)
      syncBuffered()
    }
    const onTime = () => setCurrentTime(video.currentTime)
    const onPlay = () => setStatus('playing')
    const onPause = () => setStatus(video.ended ? 'ended' : 'paused')
    const onEnded = () => setStatus('ended')
    const onWaiting = () => setStatus((s) => (s === 'playing' ? 'loading' : s))
    const onError = () => setStatus('error')
    const onEnterPiP = () => setPip(true)
    const onLeavePiP = () => setPip(false)
    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('durationchange', onLoaded)
    video.addEventListener('progress', syncBuffered)
    video.addEventListener('timeupdate', onTime)
    video.addEventListener('play', onPlay)
    video.addEventListener('playing', onPlay)
    video.addEventListener('pause', onPause)
    video.addEventListener('ended', onEnded)
    video.addEventListener('waiting', onWaiting)
    video.addEventListener('error', onError)
    video.addEventListener('enterpictureinpicture', onEnterPiP)
    video.addEventListener('leavepictureinpicture', onLeavePiP)
    onLoaded()
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('durationchange', onLoaded)
      video.removeEventListener('progress', syncBuffered)
      video.removeEventListener('timeupdate', onTime)
      video.removeEventListener('play', onPlay)
      video.removeEventListener('playing', onPlay)
      video.removeEventListener('pause', onPause)
      video.removeEventListener('ended', onEnded)
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('error', onError)
      video.removeEventListener('enterpictureinpicture', onEnterPiP)
      video.removeEventListener('leavepictureinpicture', onLeavePiP)
    }
  }, [syncBuffered, videoRef])

  useEffect(() => {
    const onFullscreen = () => setFullscreen(document.fullscreenElement === rootRef.current)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => document.removeEventListener('fullscreenchange', onFullscreen)
  }, [rootRef])

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
  }, [pause, play, videoRef])

  const seek = useCallback(
    (time: number) => {
      engineRef.current?.seek(time)
      setCurrentTime(Math.max(0, Math.min(time, duration || time)))
    },
    [duration],
  )

  const seekBy = useCallback((delta: number) => seek(currentTime + delta), [currentTime, seek])

  const setVolume = useCallback(
    (volume: number) => {
      const next = Math.max(0, Math.min(1, volume))
      engineRef.current?.setVolume(next)
      onPrefs({ ...prefs, volume: next, muted: next === 0 ? true : prefs.muted })
    },
    [onPrefs, prefs],
  )

  const setMuted = useCallback(
    (muted: boolean) => {
      engineRef.current?.setMuted(muted)
      onPrefs({ ...prefs, muted })
    },
    [onPrefs, prefs],
  )

  const setRate = useCallback(
    (rate: number) => {
      const next = Math.max(0.25, Math.min(3, rate))
      engineRef.current?.setRate(next)
      onPrefs({ ...prefs, rate: next })
    },
    [onPrefs, prefs],
  )

  const setSubtitlesOn = useCallback(
    (enabled: boolean) => onPrefs({ ...prefs, subtitlesOn: enabled }),
    [onPrefs, prefs],
  )

  const toggleSubtitles = useCallback(
    () => setSubtitlesOn(!prefs.subtitlesOn),
    [prefs.subtitlesOn, setSubtitlesOn],
  )

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
  }, [videoRef])

  const frameStep = useCallback(
    (delta: number) => {
      pause()
      seek(currentTime + delta / 30)
    },
    [currentTime, pause, seek],
  )

  return useMemo(
    () => ({
      status,
      currentTime,
      duration,
      buffered,
      volume: prefs.volume,
      muted: prefs.muted,
      rate: prefs.rate,
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
      toggleSubtitles,
      setSubtitlesOn,
      toggleFullscreen,
      togglePiP,
      frameStep,
    }),
    [
      status,
      currentTime,
      duration,
      buffered,
      prefs,
      fullscreen,
      pip,
      playPause,
      play,
      pause,
      seek,
      seekBy,
      setVolume,
      setMuted,
      setRate,
      toggleSubtitles,
      setSubtitlesOn,
      toggleFullscreen,
      togglePiP,
      frameStep,
    ],
  )
}
