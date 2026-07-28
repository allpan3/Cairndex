import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { MediaFallback } from './MediaFallback'

test('the glyph is decorative, not something a screen reader announces', () => {
  // The card is a live region, so anything readable inside it is announced
  // ahead of the heading — and a bare glyph announces as its Unicode name.
  const { container } = render(
    <MediaFallback heading="Missing file." message="It moved." meta="video · 1920 × 1080" />,
  )
  const icon = container.querySelector('.media-fallback__icon')
  expect(icon).not.toBeNull()
  // The glyph stays in the DOM (aria-hidden prunes the accessibility tree, not
  // textContent) — what matters is that the element carrying it is hidden, so
  // the announcement starts at the heading.
  expect(icon?.textContent).toContain('▦')
  expect(icon?.getAttribute('aria-hidden')).toBe('true')
  expect(icon?.closest('[aria-hidden="true"]')).toBe(icon)
})

test('renders a supplied icon instead of the default glyph', () => {
  const { container } = render(
    <MediaFallback
      heading="This video can’t be played here."
      message="Its format isn’t one this player can decode."
      meta="video · 1920 × 1080"
      icon={<svg data-testid="alert-icon" />}
    />,
  )
  expect(screen.getByTestId('alert-icon')).toBeTruthy()
  expect(container.querySelector('.media-fallback__icon')?.textContent).toBe('')
})

test('shows a retry only when one is given', () => {
  const { rerender } = render(
    <MediaFallback heading="This video can’t be played here." message="No retry." meta="video" />,
  )
  // A format the engine refused must not offer a button that replays the same
  // refusal — the absence of the action is the point, not an oversight.
  expect(screen.queryByRole('button')).toBeNull()

  rerender(
    <MediaFallback
      heading="Playback interrupted."
      message="A read stalled."
      meta="video"
      action={{ label: 'Try again', onClick: () => {} }}
    />,
  )
  expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
})
