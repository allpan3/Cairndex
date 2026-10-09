import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { ViewOptions } from './ViewOptions'

test('pointer-opened options return focus to the opener without browser click focus', async () => {
  render(
    <ViewOptions
      layout="list"
      layouts={[{ value: 'list', label: 'List' }]}
      onLayout={vi.fn()}
      zoom={200}
      min={120}
      max={300}
      onZoom={vi.fn()}
    />,
  )
  const opener = screen.getByRole('button', { name: 'View options' })
  // fireEvent omits default button focus, matching WebKit pointer behavior
  fireEvent.click(opener)
  expect(screen.getByRole('button', { name: 'Close view options' })).toHaveFocus()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() => expect(opener).toHaveFocus())
})
