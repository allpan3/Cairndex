import { expect, test, vi } from 'vitest'

import { keymapMenus } from '../../../platform/keymap'
import {
  handleViewerShortcut,
  runViewerCommand,
  type ShortcutActions,
  type ViewerCommand,
} from './useShortcuts'
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
    isFullscreen: vi.fn(() => false),
    exitFullscreen: vi.fn(),
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
  // In the shell, fullscreen is the native window, so document.fullscreenElement is
  // null and only the viewer-supplied state reveals it.
  const actions = { ...mockActions(), isFullscreen: vi.fn(() => true) }
  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), mockPlayer(), actions)
  expect(actions.exitFullscreen).toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()

  const windowed = mockActions()
  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), mockPlayer(), windowed)
  expect(windowed.close).toHaveBeenCalled()
})

test('escape leaves fullscreen on an image bundle, which has no player', () => {
  // Regression: this keyed off player.fullscreen, so a fullscreen image viewer
  // closed and left the workspace window stuck in fullscreen.
  const actions = { ...mockActions(), isFullscreen: vi.fn(() => true) }
  handleViewerShortcut(new KeyboardEvent('keydown', { key: 'Escape' }), null, actions)
  expect(actions.exitFullscreen).toHaveBeenCalled()
  expect(actions.close).not.toHaveBeenCalled()
})

test('every keymap `keys` entry reaches its declared command', () => {
  // The `keys` arrays in keymap.json are otherwise documentation only: nothing
  // stops the hand-written key ladder above from drifting away from them, which is
  // exactly the failure the shared table exists to prevent — just on the web side.
  // For each declared key, assert that pressing it produces the same observable
  // effect as invoking that item's command directly.
  const playback = keymapMenus.find((menu) => menu.id === 'playback-menu')
  expect(playback).toBeDefined()

  // Records which mock method was called with which arguments, so the key path and
  // the command path can be compared without hardcoding either mapping again.
  const trace = (run: (player: PlayerController, actions: ShortcutActions) => void) => {
    const calls: string[] = []
    const record =
      (name: string) =>
      (...args: unknown[]) =>
        void calls.push(`${name}(${JSON.stringify(args)})`)
    const player = mockPlayer() as unknown as Record<string, unknown>
    for (const key of Object.keys(player)) {
      if (typeof player[key] === 'function') player[key] = record(key)
    }
    const actions = mockActions() as unknown as Record<string, unknown>
    for (const key of Object.keys(actions)) actions[key] = record(key)
    run(player as unknown as PlayerController, actions as unknown as ShortcutActions)
    return calls
  }

  let asserted = 0
  for (const item of playback?.items ?? []) {
    const command = item.id as ViewerCommand | undefined
    if (!command) continue
    for (const key of item.keys ?? []) {
      // The table spells the bare keys as they appear on the keycap ("Space", "K");
      // KeyboardEvent.key uses " " for space and lowercase letters when unshifted.
      const eventKey = key === 'Space' ? ' ' : key.toLowerCase()
      const viaKey = trace((player, actions) =>
        handleViewerShortcut(new KeyboardEvent('keydown', { key: eventKey }), player, actions),
      )
      const viaCommand = trace((player, actions) => {
        runViewerCommand(command, player, actions)
      })
      expect(viaKey, `key "${key}" should dispatch ${command}`).toEqual(viaCommand)
      expect(viaKey.length, `key "${key}" dispatched nothing`).toBeGreaterThan(0)
      asserted += 1
    }
  }
  // Guard against the loop silently asserting nothing if the table shape changes.
  expect(asserted).toBeGreaterThanOrEqual(8)
})
