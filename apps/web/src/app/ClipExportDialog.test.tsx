import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { ClipExportDialog } from './ClipExportDialog'
import type { ClipExportTarget } from './clipExport'

const saveClipGif = vi.fn()
vi.mock('./clipExport', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./clipExport')>()),
  saveClipGif: (...args: unknown[]) => saveClipGif(...args),
}))

const TARGET: ClipExportTarget = {
  fileId: 'file-1',
  title: 'A Clip.mp4',
  sourceWidth: 1920,
  sourceHeight: 1080,
  sourceFps: 30,
}
const RANGE = { start: 4, end: 10 }

beforeEach(() => {
  saveClipGif.mockClear()
})

function open(target: ClipExportTarget = TARGET, onClose = vi.fn()) {
  render(<ClipExportDialog target={target} range={RANGE} onClose={onClose} onReport={vi.fn()} />)
  return { onClose }
}

const widths = () => within(screen.getByRole('radiogroup', { name: 'Output width' }))
const rates = () => within(screen.getByRole('radiogroup', { name: 'Frame rate' }))

test('defaults to 480px at 15 fps and says what that produces', () => {
  open()

  expect(widths().getByRole('radio', { name: '480px' })).toBeChecked()
  // The conventional GIF rate, drift and all.
  expect(rates().getByRole('radio', { name: '15 fps, ≈14.3' })).toBeChecked()
  expect(screen.getByText(/480×270/)).toBeInTheDocument()
  // Six seconds of source at fifteen a second.
  expect(screen.getByText(/90 frames/)).toBeInTheDocument()
})

// A rate the format cannot hold exactly stretches the clip as well as slowing
// it — 90 frames at a 7cs delay run 6.30s, not the 6.00s they came from. The
// summary reports what the file will actually do.
test('reports the real duration and rate when the format alters them', () => {
  open()
  expect(screen.getByText(/6\.30 s \(plays at 14\.3 fps\)/)).toBeInTheDocument()

  fireEvent.click(rates().getByRole('radio', { name: '20 fps' }))
  expect(screen.getByText(/120 frames · 6\.00 s/)).toBeInTheDocument()
  expect(screen.queryByText(/plays at/)).not.toBeInTheDocument()
})

// 15 is offered though the format cannot hold it exactly, so the wheel prints
// what it really plays at rather than leaving the difference to be discovered.
test('offers rates the source can supply, marking the one that drifts', () => {
  open()
  // A 30 fps source cannot supply 50.
  expect(
    rates()
      .getAllByRole('radio')
      .map((r) => r.getAttribute('aria-label')),
  ).toEqual(['5 fps', '10 fps', '15 fps, ≈14.3', '20 fps', '25 fps'])
  // 12 and 30 are not offered at all: they drift further and buy nothing that
  // 10, 15 or 25 does not.
  expect(rates().queryByRole('radio', { name: /^12 fps/ })).not.toBeInTheDocument()
  expect(rates().queryByRole('radio', { name: /^30 fps/ })).not.toBeInTheDocument()
})

// The wheel is the point: a segmented row fit three or four sizes, this holds
// the whole ladder.
test('offers far more widths than a row could, ending at the source', () => {
  open()

  const rungs = widths().getAllByRole('radio')
  expect(rungs.length).toBeGreaterThan(8)
  expect(rungs.at(-1)).toHaveAccessibleName('1920px, native')
  // Nothing above the source, and no separate "Original" entry.
  expect(widths().queryByRole('radio', { name: 'Original' })).not.toBeInTheDocument()
})

test('the output size follows the chosen width', () => {
  open()

  fireEvent.click(widths().getByRole('radio', { name: '320px' }))
  expect(screen.getByText(/320×180/)).toBeInTheDocument()

  fireEvent.click(widths().getByRole('radio', { name: /1920px/ }))
  expect(screen.getByText(/1920×1080/)).toBeInTheDocument()
})

test('the frame count follows the chosen rate', () => {
  open()

  fireEvent.click(rates().getByRole('radio', { name: '5 fps' }))
  expect(screen.getByText(/30 frames/)).toBeInTheDocument()

  fireEvent.click(rates().getByRole('radio', { name: '25 fps' }))
  expect(screen.getByText(/150 frames/)).toBeInTheDocument()
})

// Upscaling a GIF spends bytes on pixels the source never had.
test('drops rungs the source cannot fill', () => {
  open({ ...TARGET, sourceWidth: 640, sourceHeight: 360 })

  expect(widths().queryByRole('radio', { name: '720px' })).not.toBeInTheDocument()
  expect(widths().getByRole('radio', { name: '640px, native' })).toBeInTheDocument()
  expect(widths().getByRole('radio', { name: '480px' })).toBeChecked()
})

// The native width joins the ladder even when it is not a round number, which
// is how a clip is exported at its own size with no "Original" button.
test('adds the source’s own width when it falls between rungs', () => {
  open({ ...TARGET, sourceWidth: 1100, sourceHeight: 620 })
  expect(widths().getByRole('radio', { name: '1100px, native' })).toBeInTheDocument()
})

// A 4K source stops at the exporter's ceiling, and the note says so.
test('caps at the maximum for a source larger than it', () => {
  open({ ...TARGET, sourceWidth: 3840, sourceHeight: 2160 })

  const rungs = widths().getAllByRole('radio')
  expect(rungs.at(-1)).toHaveAccessibleName('1920px, native')
  expect(screen.getByText(/larger than the maximum/)).toBeInTheDocument()
})

test('falls back to the largest offered width when the default does not fit', () => {
  open({ ...TARGET, sourceWidth: 400, sourceHeight: 300 })

  expect(widths().getByRole('radio', { name: '400px, native' })).toBeChecked()
  expect(screen.getByText(/400×300/)).toBeInTheDocument()
})

test('an unprobed source offers the whole ladder and reports no height', () => {
  open({ fileId: 'file-1', title: 'A Clip.mp4' })

  expect(widths().getByRole('radio', { name: '1920px' })).toBeInTheDocument()
  expect(widths().queryByRole('radio', { name: /native/ })).not.toBeInTheDocument()
  expect(screen.getByText(/480px wide/)).toBeInTheDocument()
})

test('saving passes the chosen size and rate through, and closes', () => {
  const { onClose } = open()

  fireEvent.click(widths().getByRole('radio', { name: '320px' }))
  fireEvent.click(rates().getByRole('radio', { name: '25 fps' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(onClose).toHaveBeenCalled()
  expect(saveClipGif).toHaveBeenCalledWith(
    TARGET,
    RANGE,
    { width: 320, fps: 25 },
    expect.any(Function),
  )
})

test('cancelling exports nothing', () => {
  const { onClose } = open()

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalled()
  expect(saveClipGif).not.toHaveBeenCalled()
})
