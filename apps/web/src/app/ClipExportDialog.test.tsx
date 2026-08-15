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

test('defaults to 480px at 12 fps and says what that produces', () => {
  open()

  expect(screen.getByRole('button', { name: '480px' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '12 fps' })).toHaveAttribute('aria-pressed', 'true')
  // 16:9 at 480 wide, six seconds at twelve frames a second.
  expect(screen.getByText(/480×270/)).toBeInTheDocument()
  expect(screen.getByText(/72 frames/)).toBeInTheDocument()
})

test('the output size follows the chosen width', () => {
  open()

  fireEvent.click(screen.getByRole('button', { name: '240px' }))
  expect(screen.getByText(/240×136/)).toBeInTheDocument()

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

// Upscaling a GIF spends bytes on pixels the source never had, so the larger
// presets are withheld — and the note says why, or their absence reads as an
// arbitrary list.
test('withholds and explains widths above the source', () => {
  open({ ...TARGET, sourceWidth: 640, sourceHeight: 360 })

  expect(screen.queryByRole('button', { name: '720px' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: '480px' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/would upscale this source/)).toBeInTheDocument()
})

test('falls back to the largest offered width when the default does not fit', () => {
  open({ ...TARGET, sourceWidth: 400, sourceHeight: 300 })

  expect(screen.getByRole('button', { name: '320px' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/320×240/)).toBeInTheDocument()
})

test('an unprobed source offers every width and reports no height', () => {
  open({ fileId: 'file-1', title: 'A Clip.mp4' })

  expect(screen.getByRole('button', { name: '720px' })).toBeInTheDocument()
  expect(screen.getByText(/480px wide/)).toBeInTheDocument()
  expect(screen.queryByText(/would upscale/)).not.toBeInTheDocument()
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
