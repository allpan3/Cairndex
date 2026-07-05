import { expect, test, vi } from 'vitest'

import { handleViewerShortcut } from './useShortcuts'
import type { PlayerController } from './usePlayer'

/** Build a mock PlayerController for pure shortcut-dispatch tests. */
function mockPlayer(overrides: Partial<PlayerController> = {}): PlayerController {
  return {
    status: 'paused',
    currentTime: 25,
    duration: 100,
    buffered: [],
    volume: 0.5,
    muted: false,
    rate: 1,
    fullscreen: false,
    pip: false,
    subtitlesOn: true,
    playPause: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    seekBy: vi.fn(),
    setVolume: vi.fn(),
    setMuted: vi.fn(),
    setRate: vi.fn(),
    toggleSubtitles: vi.fn(),
    setSubtitlesOn: vi.fn(),
    toggleFullscreen: vi.fn(),
    togglePiP: vi.fn(),
    frameStep: vi.fn(),
    ...overrides,
  }
}

/** Build viewer-level actions for shortcut-dispatch tests. */
function mockActions() {
  return {
    close: vi.fn(),
    toggleInfo: vi.fn(),
    snapshot: vi.fn(),
  }
}

test('maps playback and seek shortcuts', () => {
  const player = mockPlayer()
  const actions = mockActions()

  expect(handleViewerShortcut(new KeyboardEvent('keydown', { key: ' ' }), player, actions)).toBe(
    true,
  )
  expect(player.playPause).toHaveBeenCalled()

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'ArrowRight' }), player, actions)
  expect(player.seekBy).toHaveBeenLastCalledWith(5)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'j' }), player, actions)
  expect(player.seekBy).toHaveBeenLastCalledWith(-10)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: '7' }), player, actions)
  expect(player.seek).toHaveBeenLastCalledWith(70)
})

test('maps player utility shortcuts', () => {
  const player = mockPlayer()
  const actions = mockActions()

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'ArrowUp' }), player, actions)
  expect(player.setVolume).toHaveBeenLastCalledWith(0.55)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'm' }), player, actions)
  expect(player.setMuted).toHaveBeenLastCalledWith(true)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'c' }), player, actions)
  expect(player.toggleSubtitles).toHaveBeenCalled()

  handleViewerShortcut(new KeyboardEvent('keydown', { key: '>', shiftKey: true }), player, actions)
  expect(player.setRate).toHaveBeenLastCalledWith(1.25)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: '.' }), player, actions)
  expect(player.frameStep).toHaveBeenCalledWith(1)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'S' }), player, actions)
  expect(actions.snapshot).toHaveBeenCalled()
})

test('maps shell shortcuts without a video player', () => {
  const actions = mockActions()

  expect(handleViewerShortcut(new KeyboardEvent('keydown', { key: 'i' }), null, actions)).toBe(true)
  expect(actions.toggleInfo).toHaveBeenCalled()

  expect(handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), null, actions)).toBe(
    true,
  )
  expect(actions.close).toHaveBeenCalled()
})
