import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ClipBar } from './ClipBar'
import type { ClipRangeController } from './useClipRange'
import type { PlayerController } from './usePlayer'

// The zoomed track measures itself, which jsdom cannot do; the clip bar's own
// controls are what these cover.
vi.mock('./ClipTimeline', () => ({ ClipTimeline: () => null }))

function controller(overrides: Partial<ClipRangeController> = {}): ClipRangeController {
  return {
    active: true,
    range: { start: 12, end: 17 },
    loop: false,
    playingRange: false,
    frame: 1 / 25,
    adjusting: false,
    adjustBase: null,
    open: vi.fn(),
    close: vi.fn(),
    markAtPlayhead: vi.fn(),
    nudge: vi.fn(),
    moveTo: vi.fn(),
    playRange: vi.fn(),
    setLoop: vi.fn(),
    armLoop: vi.fn(),
    endRangePlayback: vi.fn(),
    setAdjusting: vi.fn(),
    ...overrides,
  }
}

const player = { currentTime: 0, duration: 120 } as PlayerController

const renderBar = (overrides: Partial<ClipRangeController> = {}) => {
  const clip = controller(overrides)
  render(<ClipBar clip={clip} player={player} />)
  return clip
}

const playButton = () => screen.getByRole('button', { name: 'Play range' })
const loopToggle = () => screen.getByRole('button', { name: 'Range loop' })

test('plays the span', () => {
  const clip = renderBar()
  fireEvent.click(playButton())
  expect(clip.playRange).toHaveBeenCalledOnce()
})

// "From In" and "Range" were an action and a mode that only made sense
// together; the strip is one control lighter for merging them.
test('offers one span control, not an action and a mode', () => {
  renderBar()
  const labels = screen.getAllByRole('button').map((b) => b.textContent?.trim())
  expect(labels).toContain('▶ Play Range')
  expect(labels).not.toContain('▶ From In')
  expect(labels.filter((l) => l === '▶| Range')).toHaveLength(0)
})

// Loop is now the A-B loop's arm switch (plan 7). It still does not go through
// Play Range — arming starts the span itself, inside the controller.
test('Loop arms the range loop rather than qualifying Play Range', () => {
  const clip = renderBar()
  expect(loopToggle()).toHaveAttribute('aria-pressed', 'false')

  fireEvent.click(loopToggle())

  expect(clip.setLoop).toHaveBeenCalledWith(true)
  expect(clip.playRange).not.toHaveBeenCalled()
})

// The one click that ends the mode has to be findable while it is on, and has to
// say that is what it does.
test('an armed range loop says how to turn it off', () => {
  renderBar({ loop: true })
  expect(loopToggle().getAttribute('title')).toMatch(/Click to stop/)
})

test('Loop reads as pressed once it is armed', () => {
  renderBar({ loop: true })
  expect(loopToggle()).toHaveAttribute('aria-pressed', 'true')
})

// Whether the span is running is the one bit of state the button can usefully
// show; the ending it is heading for goes in the title.
test('shows while the span is playing', () => {
  renderBar({ playingRange: true })
  expect(playButton().className).toContain('is-active')
})

test('is idle when no span is playing', () => {
  renderBar()
  expect(playButton().className).not.toContain('is-active')
})

// Play Range is now unconditionally the one-shot: repeating is Loop's business,
// so its own description no longer changes under it.
test.each([[false], [true]])('Play Range describes one ending, with Loop=%s', (loop) => {
  renderBar({ loop })
  expect(playButton().getAttribute('title')).toMatch(/stop at Out/)
})

test('names its keyboard shortcut', () => {
  renderBar()
  expect(playButton().getAttribute('title')).toContain('\\')
})

test('is absent along with the rest of the bar when no span is marked', () => {
  render(<ClipBar clip={controller({ range: null })} player={player} />)
  expect(screen.queryByRole('button', { name: 'Play range' })).not.toBeInTheDocument()
})

// Saving the marked span as a moment (plan 7). Absent for a file that cannot
// hold one, rather than present and inert.
test('offers Save Moment only when the file can hold one', () => {
  const withSave = vi.fn()
  render(<ClipBar clip={controller()} player={player} onSaveMoment={withSave} />)
  const button = screen.getByRole('button', { name: /Save Moment/ })
  fireEvent.click(button)
  expect(withSave).toHaveBeenCalledOnce()
  expect(button.getAttribute('title')).toContain('B')
})

test('has no Save Moment control when the file cannot hold one', () => {
  renderBar()
  expect(screen.queryByRole('button', { name: /Save Moment/ })).not.toBeInTheDocument()
})

// The one-shot leads the mode beside it: play it once, or loop it.
test('leads the Loop control beside it', () => {
  renderBar()
  const labels = screen
    .getAllByRole('button')
    .map((button) => button.textContent?.trim())
    .filter((label): label is string => Boolean(label))
  expect(labels.indexOf('▶ Play Range')).toBeLessThan(labels.findIndex((l) => l.includes('Loop')))
})
