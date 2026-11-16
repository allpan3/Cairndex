import { fireEvent, render } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { CoverImage } from './CoverImage'

afterEach(() => vi.restoreAllMocks())

test('a cover fades in once it has loaded, and a new cover starts over', () => {
  const { container, rerender } = render(<CoverImage src="/a.jpg" />)
  const image = container.querySelector('img')!
  expect(image).toHaveAttribute('decoding', 'async')
  expect(image).toHaveAttribute('draggable', 'false')
  expect(image).not.toHaveClass('cover-image--shown')
  fireEvent.load(image)
  expect(image).toHaveClass('cover-image--shown')
  expect(image).not.toHaveClass('cover-image--instant')
  rerender(<CoverImage src="/b.jpg" />)
  expect(container.querySelector('img')).not.toHaveClass('cover-image--shown')
})

test('a cover the browser already holds appears without fading', () => {
  vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true)
  vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(320)
  const { container } = render(<CoverImage src="/a.jpg" />)
  expect(container.querySelector('img')).toHaveClass('cover-image--shown', 'cover-image--instant')
})

test('a cover that fails leaves the placeholder', () => {
  const { container } = render(<CoverImage src="/missing.jpg" />)
  fireEvent.error(container.querySelector('img')!)
  expect(container.querySelector('img')).toBeNull()
})
