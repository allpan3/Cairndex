import { expect, test, vi } from 'vitest'

import { handlePlaybackEnded } from './player/endBehavior'

test('file loop takes precedence over bundle auto-advance', () => {
  const player = { seek: vi.fn(), play: vi.fn() }
  const advance = vi.fn()

  handlePlaybackEnded(true, player, advance)
  expect(player.seek).toHaveBeenCalledWith(0)
  expect(player.play).toHaveBeenCalled()
  expect(advance).not.toHaveBeenCalled()

  player.seek.mockClear()
  player.play.mockClear()
  handlePlaybackEnded(false, player, advance)
  expect(advance).toHaveBeenCalled()
  expect(player.seek).not.toHaveBeenCalled()
})
