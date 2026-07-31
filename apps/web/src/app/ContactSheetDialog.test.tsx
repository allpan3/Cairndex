import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ContactSheetDialog } from './ContactSheetDialog'

test('defaults to the middle higher-resolution contact-sheet width', () => {
  render(
    <ContactSheetDialog
      target={{ fileId: 'file-one', title: 'Sample Video.mp4', duration: 120 }}
      onClose={vi.fn()}
      onReport={vi.fn()}
    />,
  )

  expect(screen.getByRole('button', { name: '1600px' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('button', { name: '2048px' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: '2560px' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByText(/16 frames at 512px wide/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: '2560px' }))
  expect(screen.getByRole('button', { name: '2560px' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByText(/16 frames at 640px wide/)).toBeInTheDocument()
})
