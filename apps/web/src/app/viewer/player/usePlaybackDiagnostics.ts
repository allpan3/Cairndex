import { useCallback, useEffect, useState } from 'react'
import type { PlaybackSource } from './engine'
import type { PlayerController } from './usePlayer'
import type { HlsSessionState } from './useHlsSession'

const MAX_EVENTS = 600

type DiagnosticValue = string | number | boolean | null | number[][]
type DiagnosticEvent = Record<string, DiagnosticValue>

// Keep a bounded local timeline without filenames, URLs, identifiers, subtitle text or credentials
export function createPlaybackJournal(now: () => number = () => performance.now()) {
  const started = now()
  const events: DiagnosticEvent[] = []
  let dropped = 0
  return {
    record(event: string, values: DiagnosticEvent = {}) {
      events.push({ atMs: Math.round(now() - started), event, ...values })
      if (events.length > MAX_EVENTS) {
        events.shift()
        dropped += 1
      }
    },
    snapshot: () => JSON.stringify({ version: 1, dropped, events }, null, 2),
  }
}

// Observe the actual element and input ordering without changing media behavior
export function usePlaybackDiagnostics({
  rootRef,
  mediaKey,
  index,
  kind,
  source,
  video,
  player,
  hls,
}: {
  rootRef: React.RefObject<HTMLElement | null>
  mediaKey: string | null
  index: number
  kind: string | null
  source: PlaybackSource | null
  video: HTMLVideoElement | null
  player: PlayerController
  hls: HlsSessionState
}) {
  const [journal] = useState(() => createPlaybackJournal())
  useEffect(() => {
    journal.record('selection', { index, kind })
  }, [mediaKey, index, kind, journal])
  useEffect(() => {
    journal.record('decision', { status: hls.status, method: hls.method })
  }, [hls.status, hls.method, journal])
  useEffect(() => {
    journal.record('intent', { wantsPlayback: player.wantsPlayback })
  }, [player.wantsPlayback, journal])
  useEffect(() => {
    journal.record('source', { kind: source?.kind ?? null, nativeHls: source?.nativeHls ?? false })
  }, [source, journal])
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const key = (event: KeyboardEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return
      const accepted = [
        ' ',
        'Escape',
        'ArrowLeft',
        'ArrowRight',
        'ArrowUp',
        'ArrowDown',
        'k',
        'j',
        'l',
        ',',
        '.',
        'f',
      ]
      if (accepted.includes(event.key))
        journal.record('key', { key: event.key, repeat: event.repeat })
    }
    const click = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null
      const control = target?.closest('.mv-btn--primary')
        ? 'play-pause'
        : target?.closest('.mv-video')
          ? 'video'
          : target?.closest('.mv-info__file')
            ? 'playlist'
            : target?.closest('.mv-seek')
              ? 'seek'
              : target?.closest('.mv-topbar')
                ? 'viewer-control'
                : 'other'
      journal.record('click', { control })
    }
    root.addEventListener('keydown', key, true)
    root.addEventListener('click', click, true)
    return () => {
      root.removeEventListener('keydown', key, true)
      root.removeEventListener('click', click, true)
    }
  }, [rootRef, journal])
  useEffect(() => {
    if (!video) return
    let presented = 0
    let frame = 0
    // Numeric observations distinguish readiness, buffering and decoded output from visible-picture proof
    const sample = (event: string) => {
      const quality = video.getVideoPlaybackQuality?.()
      const audio = video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }
      journal.record(event, {
        index,
        time: Number(video.currentTime.toFixed(3)),
        duration: Number.isFinite(video.duration) ? video.duration : null,
        paused: video.paused,
        seeking: video.seeking,
        ended: video.ended,
        readyState: video.readyState,
        networkState: video.networkState,
        error: video.error?.code ?? null,
        width: video.videoWidth,
        height: video.videoHeight,
        presented,
        decoded: quality?.totalVideoFrames ?? null,
        droppedFrames: quality?.droppedVideoFrames ?? null,
        audioDecodedBytes: audio.webkitAudioDecodedByteCount ?? null,
        activeSubtitleTracks: Array.from(video.textTracks).filter(
          (track) => track.mode === 'showing' && (track.activeCues?.length ?? 0) > 0,
        ).length,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [
          video.buffered.start(i),
          video.buffered.end(i),
        ]),
      })
    }
    const onFrame = () => {
      presented += 1
      if (presented === 1) sample('first-presented-frame')
      frame = video.requestVideoFrameCallback(onFrame)
    }
    if (video.requestVideoFrameCallback) frame = video.requestVideoFrameCallback(onFrame)
    const names = [
      'loadstart',
      'loadedmetadata',
      'canplay',
      'play',
      'playing',
      'pause',
      'waiting',
      'stalled',
      'seeking',
      'seeked',
      'ended',
      'error',
      'emptied',
    ]
    const listeners = names.map((name) => {
      const listener = () => sample(name)
      video.addEventListener(name, listener)
      return () => video.removeEventListener(name, listener)
    })
    sample('attached')
    const timer = window.setInterval(() => sample('sample'), 1000)
    return () => {
      sample('detached')
      window.clearInterval(timer)
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frame)
      listeners.forEach((stop) => stop())
    }
  }, [video, index, journal])
  return useCallback(() => journal.snapshot(), [journal])
}
