import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { DEFAULT_CLIP_SECONDS, MIN_CLIP_SECONDS, windowFor } from './clipRange'
import { useClipPlayback, useClipRange } from './useClipRange'
import type { PlayerController } from './usePlayer'

function mockPlayer(overrides: Partial<PlayerController> = {}): PlayerController {
  return {
    status: 'paused',
    currentTime: 10,
    duration: 120,
    buffered: [],
    volume: 1,
    muted: false,
    rate: 1,
    seekStep: 5,
    preservesPitch: true,
    fullscreen: false,
    pip: false,
    subtitlesOn: false,
    playPause: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    seekBy: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setRate: vi.fn(),
    setSeekStep: vi.fn(),
    setPreservesPitch: vi.fn(),
    toggleSubtitles: vi.fn(),
    toggleFullscreen: vi.fn(),
    togglePiP: vi.fn(),
    frameStep: vi.fn(),
    ...overrides,
  }
}

function setup(player = mockPlayer(), sourceKey = 'file-1') {
  return renderHook(
    ({ key }: { key: string }) =>
      useClipRange({
        player,
        // Stands in for the live media element the viewer reads.
        getCurrentTime: () => player.currentTime,
        duration: player.duration,
        fps: 25,
        sourceKey: key,
      }),
    { initialProps: { key: sourceKey } },
  )
}

test('opens with a default span running forward from the playhead', () => {
  const { result } = setup(mockPlayer({ currentTime: 10 }))
  act(() => result.current.open())

  expect(result.current.active).toBe(true)
  expect(result.current.range).toEqual({ start: 10, end: 10 + DEFAULT_CLIP_SECONDS })
})

test('marking an edge opens the picker and keeps the other edge', () => {
  const player = mockPlayer({ currentTime: 40 })
  const { result } = setup(player)

  act(() => result.current.markAtPlayhead('start'))
  expect(result.current.active).toBe(true)
  expect(result.current.range?.start).toBe(40)

  // Nothing was selected, so the first mark seeded a span; the second moves
  // only the edge it names.
  const seededEnd = result.current.range?.end
  act(() => result.current.markAtPlayhead('start'))
  expect(result.current.range?.end).toBe(seededEnd)
})

// `player.currentTime` is state fed by `timeupdate`, so it trails the element
// by a render. Marking off it recorded where the playhead *had been* — caught
// by the e2e pressing `]` straight after a seek, which marked the previous
// position and collapsed the range to its floor.
test('marks where the playhead is, not where React last saw it', () => {
  const player = mockPlayer({ currentTime: 10 })
  let live = 10
  const { result } = renderHook(() =>
    useClipRange({
      player,
      getCurrentTime: () => live,
      duration: player.duration,
      fps: 25,
      sourceKey: 'file-1',
    }),
  )

  act(() => result.current.markAtPlayhead('start'))
  expect(result.current.range?.start).toBe(10)

  // The element moves; the state copy has not caught up yet.
  live = 80
  act(() => result.current.markAtPlayhead('end'))
  expect(result.current.range?.end).toBe(80)
})

// The whole point of the picker: you cannot place an edge accurately unless
// the frame it lands on is the frame on screen.
test('nudging an edge pauses and scrubs to that edge', () => {
  const player = mockPlayer({ currentTime: 10 })
  const { result } = setup(player)
  act(() => result.current.open())

  act(() => result.current.nudge('end', result.current.frame))
  expect(player.pause).toHaveBeenCalled()
  expect(player.seek).toHaveBeenLastCalledWith(result.current.range?.end)
})

test('a drag commits without seeking when asked, so the band stays live', () => {
  const player = mockPlayer()
  const { result } = setup(player)
  act(() => result.current.open())
  const seeksBefore = vi.mocked(player.seek).mock.calls.length

  act(() => result.current.moveTo('end', 30, { scrub: false }))
  expect(result.current.range?.end).toBe(30)
  expect(vi.mocked(player.seek).mock.calls.length).toBe(seeksBefore)

  act(() => result.current.moveTo('end', 32))
  expect(player.seek).toHaveBeenLastCalledWith(32)
})

test('an edge stops short of the other rather than crossing it', () => {
  const { result } = setup()
  act(() => result.current.open())
  const end = result.current.range?.end ?? 0

  act(() => result.current.moveTo('start', end + 10))
  expect(result.current.range?.end).toBe(end)
  expect(result.current.range?.start).toBeCloseTo(end - MIN_CLIP_SECONDS)
})

// Anchoring the zoom window to the span at gesture start is what keeps a
// dragged handle under the pointer; a window recomputed from the live range
// would widen as the out-point moves right.
test('records the span a drag started from and releases it after', () => {
  const { result } = setup()
  act(() => result.current.open())
  const started = result.current.range

  act(() => result.current.setAdjusting(true))
  expect(result.current.adjusting).toBe(true)
  expect(result.current.adjustBase).toEqual(started)

  act(() => result.current.moveTo('end', 60, { scrub: false }))
  // The anchor is unchanged even though the selection has grown, so the
  // magnified window is the same one the gesture began in.
  expect(result.current.adjustBase).toEqual(started)
  expect(windowFor(result.current.adjustBase!, 120)).toEqual(windowFor(started!, 120))

  act(() => result.current.setAdjusting(false))
  expect(result.current.adjusting).toBe(false)
  expect(result.current.adjustBase).toBeNull()
})

// A span marked on one file must not be carried into the next item of the
// playlist, where it would point at unrelated footage.
test('clears the selection when the file changes', () => {
  const { result, rerender } = setup()
  act(() => result.current.open())
  act(() => result.current.setPlayMode('loop'))
  expect(result.current.range).not.toBeNull()

  rerender({ key: 'file-2' })
  expect(result.current.active).toBe(false)
  expect(result.current.range).toBeNull()
  expect(result.current.playMode).toBe('off')
})

test('closing discards the selection', () => {
  const { result } = setup()
  act(() => result.current.open())
  act(() => result.current.close())

  expect(result.current.active).toBe(false)
  expect(result.current.range).toBeNull()
})

/**
 * A stand-in for the media element: enough of the surface `useClipPlayback`
 * touches, with a `frame()` that runs whatever rAF callback is pending.
 */
function fakeVideo() {
  const listeners = new Map<string, Set<() => void>>()
  return {
    currentTime: 0,
    paused: false,
    seeking: false,
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true
    }),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)!.add(fn)
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn)
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn()
    },
  }
}

function runPlayback(video: ReturnType<typeof fakeVideo>, mode: 'off' | 'range' | 'loop') {
  const pending: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    pending.push(fn)
    return pending.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const view = renderHook(() =>
    useClipPlayback(video as unknown as HTMLVideoElement, { start: 10, end: 20 }, mode),
  )
  // One rAF turn: the effect queued the first callback at mount.
  const tick = () => pending.splice(0, pending.length).forEach((fn) => fn(0))
  return { tick, unmount: view.unmount }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('range mode stops playback at the out-point', () => {
  const video = fakeVideo()
  video.currentTime = 19
  const { tick } = runPlayback(video, 'range')

  tick()
  expect(video.pause).not.toHaveBeenCalled()

  video.currentTime = 20.1
  tick()
  expect(video.pause).toHaveBeenCalled()
  // Stopped, not rewound — the playhead stays where the clip ends.
  expect(video.currentTime).toBeCloseTo(20.1)
})

test('loop mode returns to the in-point instead of stopping', () => {
  const video = fakeVideo()
  video.currentTime = 20.1
  const { tick } = runPlayback(video, 'loop')

  tick()
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(10)
})

// Without this, pressing play after `range` parked the playhead on the
// out-point would stop again on the same frame and look like a dead button.
test('replaying after range stopped starts the span over', () => {
  const video = fakeVideo()
  video.currentTime = 20.1
  const { tick } = runPlayback(video, 'range')
  tick()
  expect(video.pause).toHaveBeenCalled()

  video.paused = false
  video.emit('play')
  expect(video.currentTime).toBe(10)
})

test('off leaves playback alone entirely', () => {
  const video = fakeVideo()
  video.currentTime = 90
  const { tick } = runPlayback(video, 'off')

  tick()
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(90)
})

// A drag is deliberately scrubbing the playhead; enforcing the out-point mid
// gesture would yank it back under the pointer. (The viewer passes 'off' while
// adjusting; this covers the other two gates.)
test('never acts on a paused or seeking element', () => {
  const video = fakeVideo()
  video.currentTime = 50
  video.paused = true
  const { tick } = runPlayback(video, 'loop')
  tick()
  expect(video.currentTime).toBe(50)

  video.paused = false
  video.seeking = true
  tick()
  expect(video.currentTime).toBe(50)
})
