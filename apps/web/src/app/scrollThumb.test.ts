import { expect, test } from 'vitest'

import { scrollTopForDrag, thumbGeometry } from './scrollThumb'

test('a panel that fits gets no thumb', () => {
  expect(thumbGeometry(0, 500, 500)).toBeNull()
  // Sub-pixel overflow is rounding, not content. Drawing for it makes a bar
  // flicker into view on panels that actually fit.
  expect(thumbGeometry(0, 500.4, 500)).toBeNull()
})

test('the thumb is as tall a share of the track as the view is of the content', () => {
  const geometry = thumbGeometry(0, 1000, 500)
  expect(geometry?.height).toBeCloseTo(250)
  expect(geometry?.offset).toBe(0)
})

test('it reaches the bottom of the track exactly at the bottom of the scroll', () => {
  // Off-by-one here shows as a thumb that never quite arrives, which reads as
  // "there is more below" when there is not.
  const geometry = thumbGeometry(500, 1000, 500)
  expect(geometry?.offset).toBeCloseTo(500 - geometry!.height)
})

test('a very long panel still gets a grabbable thumb', () => {
  const geometry = thumbGeometry(0, 100_000, 500)
  expect(geometry?.height).toBe(28)
  // And the floor must not push it past the end of the track.
  const atEnd = thumbGeometry(99_500, 100_000, 500)
  expect(atEnd?.offset).toBeCloseTo(500 - 28)
})

test('a scroll position outside the range is clamped, not extrapolated', () => {
  // Elastic overscroll reports positions past both ends.
  expect(thumbGeometry(-40, 1000, 500)?.offset).toBe(0)
  const past = thumbGeometry(9999, 1000, 500)
  expect(past?.offset).toBeCloseTo(500 - past!.height)
})

test('dragging grabs the thumb by its middle', () => {
  // Pointer at the centre of the track puts the scroll at the middle, rather
  // than jumping so the thumb starts under the pointer.
  const middle = scrollTopForDrag(250, 0, 500, 100, 1000)
  expect(middle).toBeCloseTo(500 * ((250 - 50) / 400))
})

test('dragging past either end stops at the end', () => {
  expect(scrollTopForDrag(-500, 0, 500, 100, 1000)).toBe(0)
  expect(scrollTopForDrag(5000, 0, 500, 100, 1000)).toBe(500)
})

test('a track with no room to travel cannot divide by zero', () => {
  expect(scrollTopForDrag(100, 0, 500, 500, 500)).toBe(0)
})
