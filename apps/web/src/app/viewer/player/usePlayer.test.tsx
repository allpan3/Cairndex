import { act, render, waitFor } from '@testing-library/react'
import { useEffect, useRef, useState } from 'react'
import { afterEach, expect, test, vi } from 'vitest'

import type { PlayerPrefs } from '../../types'
import { DEFAULT_PLAYER_PREFS } from '../../types'
import { usePlayer, type PlayerController } from './usePlayer'

const SOURCE = { src: '/movie.mp4', mimeType: 'video/mp4' }

/** Test component that exposes usePlayer state against a real jsdom video node. */
function Harness({
  onReady,
}: {
  onReady: (player: PlayerController, video: HTMLVideoElement, prefs: PlayerPrefs) => void
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
    source: SOURCE,
    prefs,
    onPrefs: setPrefs,
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
  unmount()
})
