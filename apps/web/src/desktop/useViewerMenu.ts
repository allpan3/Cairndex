import { useEffect, useRef } from 'react'

import type { ShortcutActions, ViewerCommand } from '../app/viewer/player/useShortcuts'
import { runViewerCommand } from '../app/viewer/player/useShortcuts'
import type { PlayerController } from '../app/viewer/player/usePlayer'
import { isDesktopHost, setHostViewerMenuAvailable } from '../platform'
import { actionIdsRequiring } from '../platform/keymap'
import type { DesktopMenuAction } from './types'
import { useDesktopMenu } from './useDesktopMenu'

// Derived from the shared table so a Playback item added to keymap.json is
// automatically recognized here instead of being silently dropped. Both groups
// count: `viewer` works for any bundle, `viewer-video` needs a player.
const PLAYBACK_ACTIONS = new Set([
  ...actionIdsRequiring('viewer'),
  ...actionIdsRequiring('viewer-video'),
])

/** True when a menu action belongs to the Playback menu. */
export function isPlaybackAction(action: DesktopMenuAction): action is ViewerCommand {
  return PLAYBACK_ACTIONS.has(action)
}

/**
 * Routes native Playback menu items to the open viewer (plan 3 §7) and keeps the
 * menu enabled only while the viewer is mounted, so the items are never live
 * against a viewer that is not on screen. Inert in the browser.
 */
export function useViewerMenu(player: PlayerController | null, actions: ShortcutActions): void {
  const playerRef = useRef(player)
  const actionsRef = useRef(actions)

  useEffect(() => {
    playerRef.current = player
    actionsRef.current = actions
  }, [actions, player])

  useDesktopMenu((action) => {
    if (!isPlaybackAction(action)) return
    runViewerCommand(action, playerRef.current, actionsRef.current)
  })

  // An image bundle has no player, so the player-only items stay disabled there
  // rather than being live-but-dead — the same reason the whole group is disabled
  // when no viewer is open at all.
  const hasVideo = player !== null
  useEffect(() => {
    if (!isDesktopHost()) return
    void setHostViewerMenuAvailable(true, hasVideo).catch((error: unknown) =>
      console.error('Could not enable the desktop Playback menu', error),
    )
  }, [hasVideo])

  useEffect(() => {
    if (!isDesktopHost()) return
    return () => {
      void setHostViewerMenuAvailable(false, false).catch((error: unknown) =>
        console.error('Could not disable the desktop Playback menu', error),
      )
    }
  }, [])
}
