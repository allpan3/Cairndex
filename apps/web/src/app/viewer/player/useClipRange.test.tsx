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
  act(() => result.current.setLoop(true))
  act(() => result.current.playRange())
  expect(result.current.range).not.toBeNull()

  rerender({ key: 'file-2' })
  expect(result.current.active).toBe(false)
  expect(result.current.range).toBeNull()
  expect(result.current.loop).toBe(false)
  expect(result.current.playingRange).toBe(false)
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
    ended: false,
    pause: vi.fn(function (this: { paused: boolean }) {
      this.paused = true
    }),
    play: vi.fn(function (this: { paused: boolean }) {
      this.paused = false
      return Promise.resolve()
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

function runPlayback(
  video: ReturnType<typeof fakeVideo>,
  options: { playing?: boolean; loop?: boolean } = {},
) {
  const pending: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    pending.push(fn)
    return pending.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const onEnd = vi.fn()
  const view = renderHook(() =>
    useClipPlayback(
      video as unknown as HTMLVideoElement,
      { start: 10, end: 20 },
      { playing: options.playing ?? true, loop: options.loop ?? false, onEnd },
    ),
  )
  // One rAF turn: the effect queued the first callback at mount.
  const tick = () => pending.splice(0, pending.length).forEach((fn) => fn(0))
  return { tick, onEnd, unmount: view.unmount }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

test('a playing span stops at the out-point', () => {
  const video = fakeVideo()
  video.currentTime = 19
  const { tick } = runPlayback(video)

  tick()
  expect(video.pause).not.toHaveBeenCalled()

  video.currentTime = 20.1
  tick()
  expect(video.pause).toHaveBeenCalled()
  // Stopped, not rewound — the playhead stays where the clip ends.
  expect(video.currentTime).toBeCloseTo(20.1)
})

test('looping returns to the in-point instead of stopping', () => {
  const video = fakeVideo()
  video.currentTime = 20.1
  const { tick } = runPlayback(video, { loop: true })

  tick()
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(10)
})

// The one fact that ends a span, wherever the pause came from — the owner
// pressing Space, or the out-point stop above.
test('a pause ends the span, so resuming is ordinary playback', () => {
  const video = fakeVideo()
  video.currentTime = 15
  const { onEnd } = runPlayback(video)

  video.emit('pause')
  expect(onEnd).toHaveBeenCalledOnce()
})

// Running off the end of the file ends the span too, but parked at the in-point
// rather than at the file's end: a browser resets an ended element's playhead
// before `play` fires, so leaving it there silently lost the selection on the
// next press (owner-reported, 2026-08-16).
test('reaching the end of the file ends the span, parked at the in-point', () => {
  const video = fakeVideo()
  video.currentTime = 240
  video.ended = true
  const { onEnd } = runPlayback(video)

  video.emit('ended')
  expect(onEnd).toHaveBeenCalledOnce()
  expect(video.currentTime).toBe(10)
})

// The case that broke: an out-point sitting on the file's own end. The media
// pauses itself first, so the tick cannot act and `pause` must not surrender.
test('a span ending at the file end still loops', () => {
  const video = fakeVideo()
  video.currentTime = 240
  video.ended = true
  const { onEnd } = runPlayback(video, { loop: true })

  // The spec fires `pause` before `ended` when the media reaches its end.
  video.emit('pause')
  expect(onEnd).not.toHaveBeenCalled()

  video.emit('ended')
  expect(video.currentTime).toBe(10)
  expect(video.play).toHaveBeenCalled()
  // Still confining: the session must survive so the span keeps repeating.
  expect(onEnd).not.toHaveBeenCalled()
})

test('an ordinary pause still ends the span, even mid-span', () => {
  const video = fakeVideo()
  video.currentTime = 15
  video.ended = false
  const { onEnd } = runPlayback(video, { loop: true })

  video.emit('pause')
  expect(onEnd).toHaveBeenCalledOnce()
})

// Space is plain playback now: with no span playing, the marks are inert.
test('leaves playback alone entirely when no span is playing', () => {
  const video = fakeVideo()
  video.currentTime = 90
  const { tick } = runPlayback(video, { playing: false })

  tick()
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(90)

  // Even past the out-point, which a mode would have pounced on.
  video.currentTime = 25
  tick()
  expect(video.pause).not.toHaveBeenCalled()
  expect(video.currentTime).toBe(25)
})

// A drag is deliberately scrubbing the playhead; enforcing the out-point mid
// gesture would yank it back under the pointer. (The viewer stops passing
// `playing` while adjusting; this covers the other two gates.)
test('never acts on a paused or seeking element', () => {
  const video = fakeVideo()
  video.currentTime = 50
  video.paused = true
  const { tick } = runPlayback(video, { loop: true })
  tick()
  expect(video.currentTime).toBe(50)

  video.paused = false
  video.seeking = true
  tick()
  expect(video.currentTime).toBe(50)
})

// --- playing the span --------------------------------------------------

test('Play Range seeks to the in-point, plays, and opens a span session', () => {
  const player = mockPlayer({ currentTime: 40 })
  const { result } = setup(player)
  act(() => result.current.open())
  const start = result.current.range!.start

  act(() => result.current.playRange())

  expect(player.seek).toHaveBeenCalledWith(start)
  expect(player.play).toHaveBeenCalledOnce()
  expect(result.current.playingRange).toBe(true)
  // Seek first: the frame that arrives is the in-point, not a moment of
  // wherever the playhead happened to be.
  expect((player.seek as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeLessThan(
    (player.play as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]!,
  )
})

// Checking a mark is nudge, press, watch, repeat — a second press has to start
// over rather than do nothing because playback is already running.
test('pressing it again restarts the span', () => {
  const player = mockPlayer({ currentTime: 40, status: 'playing' })
  const { result } = setup(player)
  act(() => result.current.open())
  const start = result.current.range!.start

  act(() => result.current.playRange())
  act(() => result.current.playRange())

  expect(player.seek).toHaveBeenNthCalledWith(2, start)
  expect(player.play).toHaveBeenCalledTimes(2)
})

test('Play Range does nothing with no span marked', () => {
  const player = mockPlayer()
  const { result } = setup(player)

  act(() => result.current.playRange())

  expect(player.seek).not.toHaveBeenCalled()
  expect(player.play).not.toHaveBeenCalled()
  expect(result.current.playingRange).toBe(false)
})

// Loop is a standing preference for what Play Range does, not a playback state
// of its own: turning it on must not start anything.
test('Loop is a preference, and does not start playback', () => {
  const player = mockPlayer({ currentTime: 10 })
  const { result } = setup(player)
  act(() => result.current.open())

  act(() => result.current.setLoop(true))

  expect(result.current.loop).toBe(true)
  expect(result.current.playingRange).toBe(false)
  expect(player.play).not.toHaveBeenCalled()
})

test('the span session ends when playback stops being confined', () => {
  const { result } = setup(mockPlayer({ currentTime: 10 }))
  act(() => result.current.open())
  act(() => result.current.playRange())
  expect(result.current.playingRange).toBe(true)

  act(() => result.current.endRangePlayback())
  expect(result.current.playingRange).toBe(false)
  // The marks and the preference survive it — only the session ended.
  expect(result.current.range).not.toBeNull()
})

test('closing the picker ends any span session with it', () => {
  const { result } = setup(mockPlayer({ currentTime: 10 }))
  act(() => result.current.open())
  act(() => result.current.setLoop(true))
  act(() => result.current.playRange())

  act(() => result.current.close())

  expect(result.current.playingRange).toBe(false)
  expect(result.current.loop).toBe(false)
  expect(result.current.range).toBeNull()
})
