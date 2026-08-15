import { fireEvent, render, screen } from '@testing-library/react'
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

test('defaults to 480px at 10 fps and says what that produces', () => {
  open()

  expect(screen.getByRole('button', { name: '480px' })).toHaveAttribute('aria-pressed', 'true')
  // 10 fps is the one preset a GIF's centisecond delays can hold exactly.
  expect(screen.getByRole('button', { name: '10 fps' })).toHaveAttribute('aria-pressed', 'true')
  // 16:9 at 480 wide, six seconds at ten frames a second.
  expect(screen.getByText(/480×270/)).toBeInTheDocument()
  expect(screen.getByText(/60 frames/)).toBeInTheDocument()
})

// The source's own width is offered last, named for what it is.
test('offers Original for the source width, after the fixed sizes', () => {
  open()

  const original = screen.getByRole('button', { name: 'Original' })
  expect(original).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: '240px' })).not.toBeInTheDocument()

  fireEvent.click(original)
  expect(screen.getByText(/1920×1080/)).toBeInTheDocument()
})

test('the output size follows the chosen width', () => {
  open()

  fireEvent.click(screen.getByRole('button', { name: '320px' }))
  expect(screen.getByText(/320×180/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '720px' }))
  expect(screen.getByText(/720×406/)).toBeInTheDocument()
})

test('the frame count follows the chosen rate', () => {
  open()

  fireEvent.click(screen.getByRole('button', { name: '8 fps' }))
  expect(screen.getByText(/48 frames/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '15 fps' }))
  expect(screen.getByText(/90 frames/)).toBeInTheDocument()
})

// Upscaling a GIF spends bytes on pixels the source never had, so fixed sizes
// at or above the source are dropped — Original covers the top end instead.
test('drops fixed sizes the source cannot fill', () => {
  open({ ...TARGET, sourceWidth: 640, sourceHeight: 360 })

  expect(screen.queryByRole('button', { name: '720px' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Original' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '480px' })).toHaveAttribute('aria-pressed', 'true')
})

// A 4K source exported at 1920 is not its original size, so the top option is
// labelled with its number and the note explains the ceiling.
test('names the top option by number when the source is over the maximum', () => {
  open({ ...TARGET, sourceWidth: 3840, sourceHeight: 2160 })

  expect(screen.queryByRole('button', { name: 'Original' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '1920px' })).toBeInTheDocument()
  expect(screen.getByText(/larger than the maximum/)).toBeInTheDocument()
})

test('falls back to the largest offered width when the default does not fit', () => {
  open({ ...TARGET, sourceWidth: 400, sourceHeight: 300 })

  expect(screen.getByRole('button', { name: 'Original' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/400×300/)).toBeInTheDocument()
})

// Nothing to resolve "Original" against, so it is not offered rather than
// guessed at.
test('an unprobed source offers the fixed sizes and reports no height', () => {
  open({ fileId: 'file-1', title: 'A Clip.mp4' })

  expect(screen.getByRole('button', { name: '720px' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Original' })).not.toBeInTheDocument()
  expect(screen.getByText(/480px wide/)).toBeInTheDocument()
})

test('saving passes the chosen size and rate through, and closes', () => {
  const { onClose } = open()

  fireEvent.click(screen.getByRole('button', { name: '320px' }))
  fireEvent.click(screen.getByRole('button', { name: '15 fps' }))
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
