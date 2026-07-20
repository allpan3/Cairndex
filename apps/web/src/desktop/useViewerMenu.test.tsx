import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { PlayerController } from '../app/viewer/player/usePlayer'
import { isDesktopHost, listenHostMenu, setHostPlaybackAvailable } from '../platform'
import type { DesktopMenuAction } from './types'
import { isPlaybackAction, useViewerMenu } from './useViewerMenu'

vi.mock('../platform', () => ({
  isDesktopHost: vi.fn(() => true),
  listenHostMenu: vi.fn().mockResolvedValue(() => undefined),
  setHostLibraryAvailable: vi.fn().mockResolvedValue(undefined),
  setHostPlaybackAvailable: vi.fn().mockResolvedValue(undefined),
}))

let emit: ((action: DesktopMenuAction) => void) | null = null

function mockActions() {
  return {
    close: vi.fn(),
    toggleInfo: vi.fn(),
    snapshot: vi.fn(),
    previous: vi.fn(),
    next: vi.fn(),
  }
}

function mockPlayer(): PlayerController {
  return { playPause: vi.fn(), seekBy: vi.fn() } as unknown as PlayerController
}

function Harness({
  player,
  actions,
}: {
  player: PlayerController | null
  actions: ReturnType<typeof mockActions>
}) {
  useViewerMenu(player, actions)
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isDesktopHost).mockReturnValue(true)
  emit = null
  vi.mocked(listenHostMenu).mockImplementation(async (handler) => {
    emit = handler
    return () => undefined
  })
})

test('classifies only Playback menu ids as viewer commands', () => {
  expect(isPlaybackAction('play-pause')).toBe(true)
  expect(isPlaybackAction('next-file')).toBe(true)
  // Workspace actions belong to App.tsx and must not be swallowed by the viewer.
  expect(isPlaybackAction('new-bundle')).toBe(false)
  expect(isPlaybackAction('settings')).toBe(false)
})

test('routes Playback menu events to the open viewer and ignores the rest', async () => {
  const player = mockPlayer()
  const actions = mockActions()
  render(<Harness player={player} actions={actions} />)
  await vi.waitFor(() => expect(emit).not.toBeNull())

  emit?.('play-pause')
  expect(player.playPause).toHaveBeenCalled()

  emit?.('next-file')
  expect(actions.next).toHaveBeenCalled()

  // A workspace action reaching this listener must be a no-op here.
  emit?.('new-bundle')
  expect(actions.next).toHaveBeenCalledTimes(1)
})

test('enables the Playback menu only while the viewer is mounted', async () => {
  const view = render(<Harness player={mockPlayer()} actions={mockActions()} />)
  await vi.waitFor(() => expect(setHostPlaybackAvailable).toHaveBeenCalledWith(true))

  view.unmount()
  // Leaving the menu live against a closed viewer would give the user items that
  // silently do nothing.
  expect(setHostPlaybackAvailable).toHaveBeenLastCalledWith(false)
})

test('stays inert in the browser', async () => {
  vi.mocked(isDesktopHost).mockReturnValue(false)
  const view = render(<Harness player={mockPlayer()} actions={mockActions()} />)
  view.unmount()
  expect(setHostPlaybackAvailable).not.toHaveBeenCalled()
})
