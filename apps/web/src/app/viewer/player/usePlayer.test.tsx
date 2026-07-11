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
  resumePosition = null,
  resumeCompleted = false,
  onResumed,
}: {
  onReady: (player: PlayerController, video: HTMLVideoElement, prefs: PlayerPrefs) => void
  source?: PlaybackSource | null
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
