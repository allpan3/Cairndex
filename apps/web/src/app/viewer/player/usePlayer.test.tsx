import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import type { PlayerPrefs } from '../../types'
import { DEFAULT_PLAYER_PREFS } from '../../types'
import { usePlayer, type PlayerController } from './usePlayer'
import type { PlaybackSource } from './engine'

const SOURCE = { src: '/movie.mp4', mimeType: 'video/mp4' }
const NEXT_SOURCE = { src: '/other.mp4', mimeType: 'video/mp4' }

/** Test component that exposes usePlayer state against a real jsdom video node. */
function Harness({
  onReady,
  source = SOURCE,
  mediaKey = 'media',
  expectedDuration = null,
  resumePosition = null,
  resumeCompleted = false,
  onResumed,
}: {
  onReady: (player: PlayerController, video: HTMLVideoElement, prefs: PlayerPrefs) => void
  source?: PlaybackSource | null
  mediaKey?: string
  expectedDuration?: number | null
  resumePosition?: number | null
  resumeCompleted?: boolean
  onResumed?: (position: number) => void
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const [prefs, setPrefs] = useState<PlayerPrefs>({
    ...DEFAULT_PLAYER_PREFS,
    volume: 0.4,
    muted: false,
    rate: 1.25,
  })
  const bindings = usePlayer({
    rootRef,
    source,
    mediaKey,
    expectedDuration,
    prefs,
    onPrefs: setPrefs,
    resumePosition,
    resumeCompleted,
    onResumed,
  })
  const { player, videoRef } = bindings

  useEffect(() => {
    if (bindings.videoElement) onReady(player, bindings.videoElement, prefs)
  }, [bindings.videoElement, onReady, player, prefs])

  return (
    <div ref={rootRef}>
      <video ref={videoRef} />
    </div>
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('loads a native source and applies persisted playback preferences', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined)
  let latest!: { player: PlayerController; video: HTMLVideoElement; prefs: PlayerPrefs }

  const { unmount } = render(
    <Harness onReady={(player, video, prefs) => (latest = { player, video, prefs })} />,
  )

  await waitFor(() => expect(latest.video.src).toContain('/movie.mp4'))
  expect(latest.video.volume).toBe(0.4)
  expect(latest.video.playbackRate).toBe(1.25)

  act(() => latest.player.setVolume(0.7))
  await waitFor(() => expect(latest.prefs.volume).toBe(0.7))
  expect(latest.video.volume).toBe(0.7)

  act(() => {
    latest.player.setMuted(true)
    latest.player.setVolume(0.6)
  })
  await waitFor(() => expect(latest.prefs.volume).toBe(0.6))
  expect(latest.prefs.muted).toBe(false)
  expect(latest.video.muted).toBe(false)

  act(() => latest.player.setRate(1.5))
  await waitFor(() => expect(latest.prefs.rate).toBe(1.5))
  expect(latest.video.playbackRate).toBe(1.5)

  act(() => {
    latest.player.setSeekStep(30)
    latest.player.setPreservesPitch(false)
  })
  await waitFor(() => expect(latest.prefs.seekStep).toBe(30))
  expect(latest.prefs.preservesPitch).toBe(false)
  expect(latest.video.preservesPitch).toBe(false)
  unmount()
})

test('seeks once to saved progress after metadata loads', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLVideoElement,
  ) {
    Object.defineProperty(this, 'duration', { configurable: true, value: 100 })
    this.dispatchEvent(new Event('loadedmetadata'))
    this.dispatchEvent(new Event('durationchange'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const onResumed = vi.fn()
  let latest!: { player: PlayerController; video: HTMLVideoElement; prefs: PlayerPrefs }

  render(
    <Harness
      resumePosition={33}
      onResumed={onResumed}
      onReady={(player, video, prefs) => (latest = { player, video, prefs })}
    />,
  )

  await waitFor(() => expect(latest.video.currentTime).toBe(33))
  expect(onResumed).toHaveBeenCalledTimes(1)
  expect(onResumed).toHaveBeenCalledWith(33)

  act(() => latest.video.dispatchEvent(new Event('loadedmetadata')))
  expect(onResumed).toHaveBeenCalledTimes(1)
})

test('does not resume completed progress', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLVideoElement,
  ) {
    Object.defineProperty(this, 'duration', { configurable: true, value: 100 })
    this.dispatchEvent(new Event('loadedmetadata'))
  })
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  const onResumed = vi.fn()
  let latest!: { player: PlayerController; video: HTMLVideoElement; prefs: PlayerPrefs }

  render(
    <Harness
      resumePosition={80}
      resumeCompleted
      onResumed={onResumed}
      onReady={(player, video, prefs) => (latest = { player, video, prefs })}
    />,
  )

  await waitFor(() => expect(latest.video.src).toContain('/movie.mp4'))
  expect(latest.video.currentTime).toBe(0)
  expect(onResumed).not.toHaveBeenCalled()
})

test('resets time, duration, and loading state when the source changes', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  let latest!: { player: PlayerController; video: HTMLVideoElement; prefs: PlayerPrefs }

  const { rerender } = render(
    <Harness onReady={(player, video, prefs) => (latest = { player, video, prefs })} />,
  )

  await waitFor(() => expect(latest.video.src).toContain('/movie.mp4'))
  act(() => {
    Object.defineProperty(latest.video, 'duration', {
      configurable: true,
      get: () => (latest.video.src.includes('/other.mp4') ? Number.NaN : 120),
    })
    latest.video.dispatchEvent(new Event('loadedmetadata'))
    latest.video.currentTime = 44
    latest.video.dispatchEvent(new Event('timeupdate'))
  })
  await waitFor(() => expect(latest.player.currentTime).toBe(44))
  expect(latest.player.duration).toBe(120)

  rerender(
    <Harness
      source={NEXT_SOURCE}
      onReady={(player, video, prefs) => (latest = { player, video, prefs })}
    />,
  )

  await waitFor(() => expect(latest.video.src).toContain('/other.mp4'))
  await waitFor(() => expect(latest.player.currentTime).toBe(0))
  expect(latest.player.duration).toBe(0)
  expect(latest.player.status).toBe('loading')
})

test('a held arrow key travels the full distance but seeks the element once', async () => {
  // jsdom's play() returns undefined; the engine awaits it.
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.useFakeTimers()
  let latest = {} as { player: PlayerController; video: HTMLVideoElement; prefs: PlayerPrefs }
  render(<Harness onReady={(player, video, prefs) => (latest = { player, video, prefs })} />)

  await vi.waitFor(() => expect(latest.video.src).toContain('/movie.mp4'))
  act(() => {
    Object.defineProperty(latest.video, 'duration', { configurable: true, get: () => 120 })
    latest.video.dispatchEvent(new Event('loadedmetadata'))
  })

  const seeks: number[] = []
  let time = 0
  Object.defineProperty(latest.video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (next: number) => {
      time = next
      seeks.push(next)
    },
  })

  // Auto-repeat: ten keydowns inside one throttle window.
  act(() => {
    for (let i = 0; i < 10; i += 1) latest.player.seekBy(1)
  })

  // The displayed position tracks every press, so the UI stays responsive…
  expect(latest.player.currentTime).toBe(10)
  // …while the element itself sees the leading edge only. Without this, each
  // press aborts the in-flight byte range and opens a new one.
  expect(seeks).toEqual([1])

  // The trailing flush commits where the key actually left off.
  act(() => {
    vi.advanceTimersByTime(200)
  })
  expect(seeks).toEqual([1, 10])
  vi.useRealTimers()
})

// Quality and recovery replace transport without overriding an explicit user pause
test('keeps an intentional pause when the same media receives a replacement source', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (
    this: HTMLVideoElement,
  ) {
    this.dispatchEvent(new Event('pause'))
  })
  let latest!: { player: PlayerController; video: HTMLVideoElement }
  const onReady = (player: PlayerController, video: HTMLVideoElement) => {
    latest = { player, video }
  }
  const view = render(<Harness onReady={onReady} />)
  await waitFor(() => expect(play).toHaveBeenCalled())
  act(() => latest.player.pause())
  play.mockClear()
  view.rerender(
    <Harness onReady={onReady} source={{ ...SOURCE, src: '/replacement.m3u8', startAt: 35 }} />,
  )
  await waitFor(() => expect(latest.video.src).toContain('/replacement.m3u8'))
  expect(play).not.toHaveBeenCalled()
})

// An abandoned engine's rejected play promise cannot pause its successor
test('ignores a delayed play rejection from the previous source', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  let reject!: (reason: Error) => void
  vi.spyOn(HTMLMediaElement.prototype, 'play')
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail
        }),
    )
    .mockResolvedValue(undefined)
  let latest!: PlayerController
  const onReady = (player: PlayerController) => {
    latest = player
  }
  const view = render(<Harness onReady={onReady} />)
  await waitFor(() => expect(reject).toBeDefined())
  view.rerender(<Harness onReady={onReady} source={NEXT_SOURCE} />)
  await act(async () => reject(new Error('abandoned playback')))
  expect(latest.status).toBe('loading')
})

// A delayed seek from a held key belongs only to the source that received it
test('cancels a trailing relative seek when the source changes', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.useFakeTimers()
  let latest!: { player: PlayerController; video: HTMLVideoElement }
  const onReady = (player: PlayerController, video: HTMLVideoElement) => {
    latest = { player, video }
  }
  const view = render(<Harness onReady={onReady} />)
  await vi.waitFor(() => expect(latest.video.src).toContain('/movie.mp4'))
  Object.defineProperty(latest.video, 'duration', { configurable: true, value: 120 })
  act(() => {
    latest.player.seekBy(10)
    latest.player.seekBy(10)
  })
  view.rerender(<Harness onReady={onReady} source={NEXT_SOURCE} />)
  act(() => vi.advanceTimersByTime(200))
  expect(latest.video.currentTime).toBe(0)
  vi.useRealTimers()
})

// Commands issued while the server prepares a source remain attached to its media selection
test('retains pause and seek commands issued before the source arrives', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(function (
    this: HTMLVideoElement,
  ) {
    Object.defineProperty(this, 'duration', { configurable: true, value: 120 })
  })
  const play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  let latest!: { player: PlayerController; video: HTMLVideoElement }
  const onReady = (player: PlayerController, video: HTMLVideoElement) => {
    latest = { player, video }
  }
  const view = render(<Harness source={null} onReady={onReady} />)
  act(() => {
    latest.player.pause()
    latest.player.seek(42)
  })
  view.rerender(<Harness source={SOURCE} onReady={onReady} />)
  await waitFor(() => expect(latest.video.currentTime).toBe(42))
  expect(play).not.toHaveBeenCalled()
  expect(latest.player.wantsPlayback).toBe(false)
  view.rerender(<Harness source={NEXT_SOURCE} mediaKey="next-media" onReady={onReady} />)
  await waitFor(() => expect(play).toHaveBeenCalledTimes(1))
})

test('an explicit zero start overrides remembered progress after metadata arrives', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  let latest!: { player: PlayerController; video: HTMLVideoElement }
  render(
    <Harness
      source={{ ...SOURCE, startAt: 0 }}
      resumePosition={33}
      onReady={(player, video) => {
        latest = { player, video }
      }}
    />,
  )
  act(() => {
    Object.defineProperty(latest.video, 'duration', { configurable: true, value: 120 })
    latest.video.dispatchEvent(new Event('loadedmetadata'))
  })
  expect(latest.video.currentTime).toBe(0)
})

// Incomplete native HLS endings retain intent and the full duration for recovery
test('a shortened HLS ending cannot report completion or advance the playlist', async () => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  let latest!: { player: PlayerController; video: HTMLVideoElement }
  render(
    <Harness
      source={{ ...SOURCE, kind: 'hls', nativeHls: true }}
      expectedDuration={150}
      onReady={(player, video) => {
        latest = { player, video }
      }}
    />,
  )
  const error = vi.fn()
  latest.video.addEventListener('error', error)
  act(() => {
    Object.defineProperty(latest.video, 'duration', { configurable: true, value: 96 })
    Object.defineProperty(latest.video, 'ended', { configurable: true, value: true })
    latest.video.currentTime = 96
    latest.video.dispatchEvent(new Event('durationchange'))
    latest.video.dispatchEvent(new Event('pause'))
  })
  expect(latest.player.status).not.toBe('ended')
  act(() => latest.video.dispatchEvent(new Event('ended')))
  expect(error).toHaveBeenCalledTimes(1)
  expect(latest.player.status).toBe('error')
  expect(latest.player.wantsPlayback).toBe(true)
  expect(latest.player.duration).toBe(150)
  act(() => {
    latest.video.currentTime = 150
    latest.video.dispatchEvent(new Event('ended'))
  })
  expect(latest.player.status).toBe('ended')
})
