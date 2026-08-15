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

test('defaults to 480px at 10 fps and says what that produces', () => {
  open()

  expect(widths().getByRole('radio', { name: '480px' })).toBeChecked()
  // 10 fps is the one choice a GIF's centisecond delays can hold exactly.
  expect(rates().getByRole('radio', { name: '10 fps, exact' })).toBeChecked()
  // 16:9 at 480 wide, six seconds at ten frames a second.
  expect(screen.getByText(/480×270/)).toBeInTheDocument()
  expect(screen.getByText(/60 frames/)).toBeInTheDocument()
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

  fireEvent.click(rates().getByRole('radio', { name: '15 fps' }))
  expect(screen.getByText(/90 frames/)).toBeInTheDocument()
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
  fireEvent.click(rates().getByRole('radio', { name: '15 fps' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))

  expect(onClose).toHaveBeenCalled()
  expect(saveClipGif).toHaveBeenCalledWith(
    TARGET,
    RANGE,
    { width: 320, fps: 15 },
    expect.any(Function),
  )
})

test('cancelling exports nothing', () => {
  const { onClose } = open()

  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(onClose).toHaveBeenCalled()
  expect(saveClipGif).not.toHaveBeenCalled()
})
