import { expect, test, vi } from 'vitest'

import { handleViewerShortcut, runViewerCommand } from './useShortcuts'
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
    seekStep: 5,
    preservesPitch: true,
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
    setSeekStep: vi.fn(),
    setPreservesPitch: vi.fn(),
    toggleSubtitles: vi.fn(),
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
    previous: vi.fn(),
    next: vi.fn(),
  }
}

test('maps playback and configurable seek shortcuts', () => {
  const player = mockPlayer({ seekStep: 30 })
  const actions = mockActions()

  expect(handleViewerShortcut(new KeyboardEvent('keydown', { key: ' ' }), player, actions)).toBe(
    true,
  )
  expect(player.playPause).toHaveBeenCalled()

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'ArrowRight' }), player, actions)
  expect(player.seekBy).toHaveBeenLastCalledWith(30)

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

  handleViewerShortcut(new KeyboardEvent('keydown', { key: '>' }), player, actions)
  expect(player.frameStep).toHaveBeenLastCalledWith(1)
  handleViewerShortcut(new KeyboardEvent('keydown', { key: '<' }), player, actions)
  expect(player.frameStep).toHaveBeenLastCalledWith(-1)

  handleViewerShortcut(new KeyboardEvent('keydown', { key: '.' }), player, actions)
  expect(player.setRate).toHaveBeenLastCalledWith(1.25)
  handleViewerShortcut(new KeyboardEvent('keydown', { key: ',' }), player, actions)
  expect(player.setRate).toHaveBeenLastCalledWith(0.75)

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

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'ArrowRight' }), null, actions)
  expect(actions.next).toHaveBeenCalled()
})

test('runs Playback menu commands through the same dispatcher as the keys', () => {
  const player = mockPlayer()
  const actions = mockActions()

  // The native Playback menu drives these ids; each must reach the same handler
  // its key binding does, so the two surfaces cannot drift (plan 3 §7).
  expect(runViewerCommand('play-pause', player, actions)).toBe(true)
  expect(player.playPause).toHaveBeenCalled()

  runViewerCommand('seek-forward', player, actions)
  expect(player.seekBy).toHaveBeenLastCalledWith(10)
  runViewerCommand('seek-back', player, actions)
  expect(player.seekBy).toHaveBeenLastCalledWith(-10)

  runViewerCommand('rate-up', player, actions)
  expect(player.setRate).toHaveBeenLastCalledWith(1.25)

  runViewerCommand('toggle-mute', player, actions)
  expect(player.setMuted).toHaveBeenLastCalledWith(true)

  runViewerCommand('toggle-subtitles', player, actions)
  expect(player.toggleSubtitles).toHaveBeenCalled()

  runViewerCommand('snapshot', player, actions)
  expect(actions.snapshot).toHaveBeenCalled()
})

test('navigates files from the menu even with no video player', () => {
  const actions = mockActions()

  // Images have no PlayerController but still need Previous/Next File to work.
  expect(runViewerCommand('next-file', null, actions)).toBe(true)
  expect(actions.next).toHaveBeenCalled()
  expect(runViewerCommand('previous-file', null, actions)).toBe(true)
  expect(actions.previous).toHaveBeenCalled()

  // Player-only commands must report "not handled" rather than throwing.
  expect(runViewerCommand('play-pause', null, actions)).toBe(false)
  expect(runViewerCommand('snapshot', null, actions)).toBe(false)
})

test('escape leaves native fullscreen before it closes the viewer', () => {
  const actions = mockActions()
  // In the shell, fullscreen is the native window, so document.fullscreenElement
  // is null and only the player's own state reveals it.
  const player = mockPlayer({ fullscreen: true })

  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), player, actions)
  expect(player.toggleFullscreen).toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()

  const windowed = mockPlayer({ fullscreen: false })
  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), windowed, actions)
  expect(actions.close).toHaveBeenCalled()
})
