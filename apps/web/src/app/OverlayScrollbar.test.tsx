import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { OverlayScrollbar } from './OverlayScrollbar'

afterEach(() => {
  vi.useRealTimers()
})

// Hidden until the panel scrolls, then gone a moment later (owner, 2026-10-18)
test('shows the thumb only while its panel scrolls', () => {
  vi.useFakeTimers()
  const { container } = render(
    <div className="sidebar">
      <OverlayScrollbar />
    </div>,
  )
  const panel = container.firstElementChild as HTMLElement
  Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 1000 })
  Object.defineProperty(panel, 'clientHeight', { configurable: true, value: 200 })

  act(() => {
    fireEvent.scroll(panel)
    vi.advanceTimersToNextFrame()
  })
  const thumb = container.querySelector('.oscroll__thumb')!
  expect(thumb).toHaveClass('oscroll__thumb--scrolling')

  act(() => vi.advanceTimersByTime(1000))
  expect(thumb).not.toHaveClass('oscroll__thumb--scrolling')
})
