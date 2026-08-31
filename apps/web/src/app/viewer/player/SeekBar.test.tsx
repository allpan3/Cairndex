import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { Moment, PlayableVideo } from '../../../api/client'
import { SeekBar } from './SeekBar'
import type { PlayerController } from './usePlayer'

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient()
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function momentFixture(overrides: Partial<Moment>): Moment {
  return {
    id: 'moment',
    bundle_id: 'bundle',
    file_id: 'file',
    start_s: 0,
    end_s: null,
    comment: null,
    tag_ids: [],
    version: 1,
    created_at: '2026-08-29T00:00:00Z',
    updated_at: '2026-08-29T00:00:00Z',
    ...overrides,
  } as Moment
}

// A 100s video whose seek bar spans clientX 0..1000, so time = clientX / 10.
function setup(moments: Moment[] = []) {
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [] as { start: number; end: number }[],
    seek,
    seekBy: vi.fn(),
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} moments={moments} />, { wrapper })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 1000,
    top: 0,
    height: 8,
    right: 1000,
    bottom: 8,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  return { seek, track, container: utils.container }
}

beforeEach(() => {
  vi.useFakeTimers()
  // jsdom doesn't implement pointer capture.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
  cleanup()
  vi.restoreAllMocks()
})

test('coalesces a burst of drag moves into few seeks and commits the release position', () => {
  const { seek, track } = setup()

  // Press seeks immediately (leading edge).
  fireEvent.pointerDown(track, { clientX: 100, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1)
  expect(seek).toHaveBeenLastCalledWith(10)

  // A rapid drag: 20 moves within the same throttle window issue no new seeks.
  for (let x = 110; x <= 300; x += 10) {
    fireEvent.pointerMove(track, { clientX: x, buttons: 1, pointerId: 1 })
  }
  expect(seek).toHaveBeenCalledTimes(1)

  // Release commits the exact final position and cancels the pending flush.
  fireEvent.pointerUp(track, { clientX: 300, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(2)
  expect(seek).toHaveBeenLastCalledWith(30)

  // No trailing flush fires after release.
  vi.advanceTimersByTime(1000)
  expect(seek).toHaveBeenCalledTimes(2)
})

test('flushes the latest position once the throttle window elapses mid-drag', () => {
  const { seek, track } = setup()

  fireEvent.pointerDown(track, { clientX: 0, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1) // seek(0)

  // Moves within the window are coalesced into a pending trailing seek.
  fireEvent.pointerMove(track, { clientX: 200, buttons: 1, pointerId: 1 })
  fireEvent.pointerMove(track, { clientX: 400, buttons: 1, pointerId: 1 })
  expect(seek).toHaveBeenCalledTimes(1)

  // After the window elapses the trailing flush seeks the last requested spot.
  vi.advanceTimersByTime(150)
  expect(seek).toHaveBeenCalledTimes(2)
  expect(seek).toHaveBeenLastCalledWith(40)
})

test('tracks the captured pointer off-track and pins chrome until window release', () => {
  const onDragChange = vi.fn()
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [],
    seek,
    seekBy: vi.fn(),
    seekStep: 30,
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} onDragChange={onDragChange} />, {
    wrapper,
  })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 100,
    width: 400,
    top: 0,
    height: 8,
    right: 500,
    bottom: 8,
    x: 100,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)

  fireEvent.pointerDown(track, { clientX: 200, pointerId: 7, button: 0 })
  fireEvent.pointerMove(window, { clientX: 900, pointerId: 7, buttons: 1 })
  vi.advanceTimersByTime(150)
  fireEvent.pointerUp(window, { clientX: 900, pointerId: 7 })

  expect(Element.prototype.setPointerCapture).toHaveBeenCalledWith(7)
  expect(seek).toHaveBeenLastCalledWith(100)
  expect(onDragChange.mock.calls).toEqual([[true], [false]])

  fireEvent.keyDown(track, { key: 'ArrowLeft' })
  expect(player.seekBy).toHaveBeenLastCalledWith(-30)
})

test('releases the parent drag pin when unmounted mid-drag', () => {
  const onDragChange = vi.fn()
  const seek = vi.fn()
  const player = {
    duration: 100,
    currentTime: 0,
    buffered: [],
    seek,
    seekBy: vi.fn(),
    seekStep: 5,
  } as unknown as PlayerController
  const video = { chapters: [], storyboard_url: null } as unknown as PlayableVideo
  const utils = render(<SeekBar player={player} video={video} onDragChange={onDragChange} />, {
    wrapper,
  })
  const track = utils.container.querySelector('.mv-seek__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 100,
    top: 0,
    height: 8,
    right: 100,
    bottom: 8,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)

  fireEvent.pointerDown(track, { clientX: 50, pointerId: 2, button: 0 })
  utils.unmount()

  expect(onDragChange.mock.calls).toEqual([[true], [false]])
})

// --- Saved moments on the track (plan 7) -------------------------------
// A frame is a tick, a range is a band: the shapes say which kind each is
// without a legend.
test('draws a tick for a frame moment and a band for a range', () => {
  const { container } = setup([
    momentFixture({ id: 'frame', start_s: 25 }),
    momentFixture({ id: 'span', start_s: 50, end_s: 60 }),
  ])

  const tick = container.querySelector('.mv-seek__moment-tick') as HTMLElement
  const band = container.querySelector('.mv-seek__moment-band') as HTMLElement
  expect(tick.style.left).toBe('25%')
  expect(band.style.left).toBe('50%')
  expect(band.style.width).toBe('10%')
  expect(container.querySelectorAll('.mv-seek__moment-tick')).toHaveLength(1)
})

// A very short span would otherwise be a sub-pixel sliver — invisible, and so
// indistinguishable from not having been saved at all.
test('a very short range still has a visible width', () => {
  const { container } = setup([momentFixture({ id: 'span', start_s: 10, end_s: 10.05 })])

  const band = container.querySelector('.mv-seek__moment-band') as HTMLElement
  expect(Number.parseFloat(band.style.width)).toBeGreaterThanOrEqual(0.4)
})

// A moment past the end of the media is not drawn rather than drawn off the
// track: a file replaced by a shorter one leaves rows behind it.
test('skips a moment that lies past the duration', () => {
  const { container } = setup([momentFixture({ id: 'gone', start_s: 400 })])
  expect(container.querySelector('.mv-seek__moment-tick')).toBeNull()
})

test('the hover tooltip names the moment under the pointer', () => {
  const { track, container } = setup([
    momentFixture({ id: 'span', start_s: 50, end_s: 60, comment: 'the reaction' }),
  ])

  fireEvent.pointerMove(track, { clientX: 550 })
  expect(container.querySelector('.mv-seek__moment-note')?.textContent).toContain('the reaction')

  // Outside it, there is nothing to name.
  fireEvent.pointerMove(track, { clientX: 200 })
  expect(container.querySelector('.mv-seek__moment-note')).toBeNull()
})

// A range says more than a frame inside it, so it wins the tooltip.
test('a range outranks a frame inside it', () => {
  const { track, container } = setup([
    momentFixture({ id: 'frame', start_s: 55, comment: 'the frame' }),
    momentFixture({ id: 'span', start_s: 50, end_s: 60, comment: 'the span' }),
  ])

  fireEvent.pointerMove(track, { clientX: 550 })
  expect(container.querySelector('.mv-seek__moment-note')?.textContent).toContain('the span')
})

// The markers are a map, not a control: the track's own pointerdown scrubs, and
// a click target competing with it is a separate design problem.
test('markers never intercept the scrub gesture', () => {
  const { container } = setup([
    momentFixture({ id: 'frame', start_s: 25 }),
    momentFixture({ id: 'span', start_s: 50, end_s: 60 }),
  ])

  for (const mark of container.querySelectorAll<HTMLElement>(
    '.mv-seek__moment-tick, .mv-seek__moment-band',
  )) {
    expect(mark.getAttribute('aria-hidden')).toBe('true')
  }
})
