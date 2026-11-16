import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ZoomSlider } from './ZoomSlider'

test('a dragged zoom previews each step and commits once on release', () => {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  render(<ZoomSlider value={200} min={140} max={640} onPreview={onPreview} onCommit={onCommit} />)
  const slider = screen.getByRole('slider', { name: 'Zoom' })
  fireEvent.pointerDown(slider)
  fireEvent.change(slider, { target: { value: '260' } })
  fireEvent.change(slider, { target: { value: '300' } })
  expect(onPreview.mock.calls).toEqual([[260], [300]])
  expect(onCommit).not.toHaveBeenCalled()
  expect(slider).toHaveValue('300')
  fireEvent.pointerUp(window)
  expect(onPreview).toHaveBeenLastCalledWith(null)
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(300)
})

test('a keyboard step commits at once', () => {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  render(<ZoomSlider value={200} min={140} max={640} onPreview={onPreview} onCommit={onCommit} />)
  fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '210' } })
  expect(onCommit).toHaveBeenCalledExactlyOnceWith(210)
  expect(onPreview).not.toHaveBeenCalled()
})

test('a drag released where it started ends the preview without a commit', () => {
  const onPreview = vi.fn()
  const onCommit = vi.fn()
  render(<ZoomSlider value={200} min={140} max={640} onPreview={onPreview} onCommit={onCommit} />)
  const slider = screen.getByRole('slider', { name: 'Zoom' })
  fireEvent.pointerDown(slider)
  fireEvent.change(slider, { target: { value: '260' } })
  fireEvent.change(slider, { target: { value: '200' } })
  fireEvent.pointerUp(window)
  expect(onPreview).toHaveBeenLastCalledWith(null)
  expect(onCommit).not.toHaveBeenCalled()
})
