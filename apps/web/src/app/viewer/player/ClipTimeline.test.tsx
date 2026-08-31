import { fireEvent, render } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ClipTimeline } from './ClipTimeline'
import type { ClipRangeController } from './useClipRange'
import type { PlayerController } from './usePlayer'

/**
 * The magnified track fits the selection by default, which stops being enough
 * once the selection is long: the wheel zooms it and Alt+wheel pans it (owner,
 * 2026-08-30). The window's two ends are printed either side of the track, so
 * they are what these read.
 */
function setup(range = { start: 40, end: 60 }) {
  const clip = {
    range,
    adjustBase: null,
    frame: 1 / 25,
    nudge: vi.fn(),
    moveTo: vi.fn(),
    setAdjusting: vi.fn(),
  } as unknown as ClipRangeController
  const player = { duration: 600, currentTime: 45, seek: vi.fn() } as unknown as PlayerController
  const utils = render(<ClipTimeline clip={clip} player={player} />)
  const track = utils.container.querySelector('.mv-clip-zoom__track') as HTMLElement
  vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    width: 1000,
    top: 0,
    height: 26,
    right: 1000,
    bottom: 26,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect)
  const edges = () =>
    [...utils.container.querySelectorAll('.mv-clip-zoom__edge')].map((n) => n.textContent)
  const width = () => {
    const [a, b] = edges()
    const secs = (t: string) => {
      const [m, rest] = t!.split(':')
      return Number(m) * 60 + Number(rest)
    }
    return secs(b!) - secs(a!)
  }
  return { track, edges, width, utils }
}

test('the wheel zooms the magnified track', () => {
  const { track, width } = setup()
  const fitted = width()

  fireEvent.wheel(track, { deltaY: -100, clientX: 500 })
  const zoomedIn = width()
  expect(zoomedIn).toBeLessThan(fitted)

  fireEvent.wheel(track, { deltaY: 100, clientX: 500 })
  fireEvent.wheel(track, { deltaY: 100, clientX: 500 })
  expect(width()).toBeGreaterThan(zoomedIn)
})

// Zooming keeps the instant under the pointer still, which is what makes it
// usable for aiming at a frame rather than a general magnifier.
test('zooming holds the time under the pointer', () => {
  const { track, edges } = setup()
  const before = edges()[0]

  // At the far left, the window's start is the point under the cursor.
  fireEvent.wheel(track, { deltaY: -100, clientX: 0 })
  expect(edges()[0]).toBe(before)
})

test('Alt+wheel pans without changing the magnification', () => {
  const { track, width, edges } = setup()
  fireEvent.wheel(track, { deltaY: -100, clientX: 500 })
  const zoomed = width()
  const start = edges()[0]

  fireEvent.wheel(track, { deltaY: 100, clientX: 500, altKey: true })

  expect(width()).toBeCloseTo(zoomed, 5)
  expect(edges()[0]).not.toBe(start)
})

// The one way back from a hand-set window.
test('double-click refits the track to the selection', () => {
  const { track, width } = setup()
  const fitted = width()
  fireEvent.wheel(track, { deltaY: -100, clientX: 500 })
  expect(width()).toBeLessThan(fitted)

  fireEvent.doubleClick(track)
  expect(width()).toBeCloseTo(fitted, 5)
})

// A hand-set window that no longer shows any of the selection would strand the
// owner on empty timeline with the handles nowhere; it re-fits instead.
test('a window the selection has left re-fits itself', () => {
  const { track, width, utils } = setup()
  const fitted = width()
  fireEvent.wheel(track, { deltaY: -100, clientX: 0 })
  expect(width()).toBeLessThan(fitted)

  const moved = {
    range: { start: 400, end: 420 },
    adjustBase: null,
    frame: 1 / 25,
    nudge: vi.fn(),
    moveTo: vi.fn(),
    setAdjusting: vi.fn(),
  } as unknown as ClipRangeController
  const player = { duration: 600, currentTime: 405, seek: vi.fn() } as unknown as PlayerController
  utils.rerender(<ClipTimeline clip={moved} player={player} />)

  expect(width()).toBeCloseTo(fitted, 5)
})

// The viewer turns a wheel into volume; over this track the wheel is the zoom
// and nothing else (owner, 2026-08-30: "priority is given to the range chrome").
test('the track keeps the wheel to itself', () => {
  const { track } = setup()
  const seenByViewer = vi.fn()
  document.addEventListener('wheel', seenByViewer)

  const event = new WheelEvent('wheel', { deltaY: -100, clientX: 500, bubbles: true })
  track.dispatchEvent(event)

  expect(seenByViewer).not.toHaveBeenCalled()
  document.removeEventListener('wheel', seenByViewer)
})
