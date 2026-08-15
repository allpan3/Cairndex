import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ContactSheetDialog } from './ContactSheetDialog'

function open() {
  render(
    <ContactSheetDialog
      target={{ fileId: 'file-one', title: 'Sample Video.mp4', duration: 120 }}
      onClose={vi.fn()}
      onReport={vi.fn()}
    />,
  )
}

const grid = () => within(screen.getByRole('radiogroup', { name: 'Grid size' }))
const widths = () => within(screen.getByRole('radiogroup', { name: 'Sheet width' }))

test('defaults to a 4×4 grid at the middle width, and says what that gives', () => {
  open()

  expect(grid().getByRole('radio', { name: '4 × 4, default' })).toBeChecked()
  expect(widths().getByRole('radio', { name: '2048px, default' })).toBeChecked()
  expect(screen.getByText(/16 frames at 512px wide/)).toBeInTheDocument()
})

// The wheels are what let these ladders grow past what a segmented row held —
// three grids and three widths before, five and ten now.
test('offers more grids and widths than a row could hold', () => {
  open()

  expect(grid().getAllByRole('radio')).toHaveLength(5)
  expect(widths().getAllByRole('radio')).toHaveLength(10)
  expect(grid().getByRole('radio', { name: '2 × 2' })).toBeInTheDocument()
  expect(widths().getByRole('radio', { name: '6144px' })).toBeInTheDocument()
})

test('the cell size follows both choices', () => {
  open()

  fireEvent.click(widths().getByRole('radio', { name: '6144px' }))
  expect(screen.getByText(/16 frames at 1536px wide/)).toBeInTheDocument()

  fireEvent.click(grid().getByRole('radio', { name: '2 × 2' }))
  expect(screen.getByText(/4 frames at 3072px wide/)).toBeInTheDocument()
})

test('says how often a frame is sampled when the interval is worth printing', () => {
  open()

  fireEvent.click(grid().getByRole('radio', { name: '2 × 2' }))
  // Four frames across two minutes.
  expect(screen.getByText(/roughly one every/)).toBeInTheDocument()
})
