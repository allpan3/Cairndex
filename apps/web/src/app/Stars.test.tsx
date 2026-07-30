import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { formatRating, formatRatingCompact, ratingKey, valueFromPointerX } from './rating'
import { StarRating, StarRow } from './Stars'

test('ratingKey matches the server facet keys', () => {
  // The server keys whole stars without a decimal part (domain/rating.py), and
  // the counts map is looked up by this string — a mismatch shows as a silent 0.
  expect(ratingKey(4)).toBe('4')
  expect(ratingKey(3.5)).toBe('3.5')
  expect(ratingKey(0.5)).toBe('0.5')
})

test('ratings format as star counts rather than decimals', () => {
  expect(formatRatingCompact(3)).toBe('3')
  expect(formatRatingCompact(3.5)).toBe('3½')
  expect(formatRatingCompact(0.5)).toBe('½')
  expect(formatRating(1)).toBe('1 star')
  expect(formatRating(2.5)).toBe('2½ stars')
})

test('each star exposes both halves as separate options', () => {
  render(<StarRow value={0} onPick={vi.fn()} />)
  expect(screen.getAllByRole('radio')).toHaveLength(10)
  expect(screen.getByLabelText('½ stars')).toBeTruthy()
  expect(screen.getByLabelText('3½ stars')).toBeTruthy()
  expect(screen.getByLabelText('5 stars')).toBeTruthy()
})

test('picking a half star reports the half value', () => {
  const onPick = vi.fn()
  render(<StarRow value={0} onPick={onPick} />)
  fireEvent.click(screen.getByLabelText('2½ stars'))
  expect(onPick).toHaveBeenCalledWith(2.5)
})

test('the selected half is the checked option', () => {
  render(<StarRow value={3.5} onPick={vi.fn()} />)
  expect(screen.getByLabelText('3½ stars').getAttribute('aria-checked')).toBe('true')
  expect(screen.getByLabelText('3 stars').getAttribute('aria-checked')).toBe('false')
  expect(screen.getByLabelText('4 stars').getAttribute('aria-checked')).toBe('false')
})

test('facet counts follow the hovered half', () => {
  // With nothing hovered the row shows whole-star counts, exactly as it did
  // before half stars; hovering a left half swaps in that half's own count.
  const counts = { '3': 2, '3.5': 7 }
  render(<StarRow value={0} onPick={vi.fn()} counts={counts} />)
  expect(screen.getByText('2')).toBeTruthy()

  fireEvent.mouseEnter(screen.getByLabelText('3½ stars'))
  expect(screen.getByText('7')).toBeTruthy()
})

test('the inspector editor clears when the current value is picked again', () => {
  const onChange = vi.fn()
  render(<StarRating value={2.5} onChange={onChange} />)

  fireEvent.click(screen.getByLabelText('2½ stars'))
  expect(onChange).toHaveBeenCalledWith(0)

  fireEvent.click(screen.getByLabelText('4 stars'))
  expect(onChange).toHaveBeenLastCalledWith(4)
})

// --- Drag-to-rate ---------------------------------------------------------

test('valueFromPointerX maps row geometry to half-star values', () => {
  // Five 20px-wide glyphs at x = 0, 24, 48, 72, 96.
  const glyphs = [0, 24, 48, 72, 96].map(
    (left) => ({ getBoundingClientRect: () => ({ left, width: 20 }) }) as unknown as Element,
  )
  expect(valueFromPointerX(glyphs, -50)).toBe(0.5) // left of everything clamps
  expect(valueFromPointerX(glyphs, 2)).toBe(0.5) // left half of star 1
  expect(valueFromPointerX(glyphs, 12)).toBe(1) // right half of star 1
  expect(valueFromPointerX(glyphs, 22)).toBe(1) // the gap keeps the last value
  expect(valueFromPointerX(glyphs, 50)).toBe(2.5) // left half of star 3
  expect(valueFromPointerX(glyphs, 60)).toBe(3) // right half of star 3
  expect(valueFromPointerX(glyphs, 500)).toBe(5) // right of everything clamps
})

test('a press-and-release in place leaves the pick to the half button', () => {
  // The release must NOT commit and must NOT swallow the click: picking a rating
  // has to work without pointer capture, because the desktop shell's WebKit does
  // not retarget the release to the row and a click there did nothing at all
  // (owner-reported, 2026-07-30).
  const onPick = vi.fn()
  render(<StarRow value={0} onPick={onPick} />)
  const row = screen.getByRole('radiogroup')

  fireEvent.pointerDown(row, { clientX: 0, button: 0 })
  fireEvent.pointerUp(row, { clientX: 0 })
  expect(onPick).not.toHaveBeenCalled()

  // The click that follows the gesture is what picks — once.
  fireEvent.click(screen.getByLabelText('2½ stars'))
  expect(onPick).toHaveBeenCalledTimes(1)
  expect(onPick).toHaveBeenCalledWith(2.5)

  // And a later plain click (keyboard, or a fresh mouse click) still works.
  fireEvent.click(screen.getByLabelText('3 stars'))
  expect(onPick).toHaveBeenCalledTimes(2)
  expect(onPick).toHaveBeenLastCalledWith(3)
})

test('a sweep takes the drag path, not the click path', () => {
  const onPick = vi.fn()
  const onSet = vi.fn()
  render(<StarRow value={0} onPick={onPick} onSet={onSet} />)
  const row = screen.getByRole('radiogroup')

  // Zero rects make every x read as 5, so fake a moved gesture by nudging the
  // last glyph's rect between down and move.
  const glyphs = row.querySelectorAll('.star__glyph')
  fireEvent.pointerDown(row, { clientX: 0, button: 0 })
  Object.defineProperty(glyphs[4], 'getBoundingClientRect', {
    value: () => ({ left: 1000, width: 20 }),
    configurable: true,
  })
  fireEvent.pointerMove(row, { clientX: 0 })
  fireEvent.pointerUp(row, { clientX: 0 })

  expect(onSet).toHaveBeenCalledTimes(1)
  expect(onPick).not.toHaveBeenCalled()
})

test('hovering names the value in the hint', () => {
  render(<StarRow value={0} onPick={vi.fn()} />)
  expect(screen.queryByText('3½ stars')).toBeNull()
  fireEvent.mouseEnter(screen.getByLabelText('3½ stars'))
  expect(screen.getByText('3½ stars')).toBeInTheDocument()
})

test('the editor clears on a repeated click but never on a sweep', () => {
  const onChange = vi.fn()
  render(<StarRating value={5} onChange={onChange} />)
  const row = screen.getByRole('radiogroup')

  // A click on the current value clears — and it is the half button's click that
  // does it, not the release.
  fireEvent.pointerDown(row, { clientX: 0, button: 0 })
  fireEvent.pointerUp(row, { clientX: 0 })
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(screen.getByLabelText('5 stars'))
  expect(onChange).toHaveBeenCalledWith(0)

  onChange.mockClear()
  // A sweep that ends on the current value changes nothing at all.
  const glyphs = row.querySelectorAll('.star__glyph')
  fireEvent.pointerDown(row, { clientX: 0, button: 0 })
  Object.defineProperty(glyphs[4], 'getBoundingClientRect', {
    value: () => ({ left: 1000, width: 20 }),
    configurable: true,
  })
  fireEvent.pointerMove(row, { clientX: 0 })
  Object.defineProperty(glyphs[4], 'getBoundingClientRect', {
    value: () => ({ left: 0, width: 0 }),
    configurable: true,
  })
  fireEvent.pointerUp(row, { clientX: 0 })
  expect(onChange).not.toHaveBeenCalled()
})
