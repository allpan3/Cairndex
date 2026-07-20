import { useEffect, useRef } from 'react'

import type { ShortcutActions, ViewerCommand } from '../app/viewer/player/useShortcuts'
import { runViewerCommand } from '../app/viewer/player/useShortcuts'
import type { PlayerController } from '../app/viewer/player/usePlayer'
import { isDesktopHost, setHostPlaybackAvailable } from '../platform'
import { actionIdsRequiring } from '../platform/keymap'
import type { DesktopMenuAction } from './types'
import { useDesktopMenu } from './useDesktopMenu'

// Derived from the shared table so a Playback item added to keymap.json is
// automatically recognized here instead of being silently dropped.
const PLAYBACK_ACTIONS = new Set(actionIdsRequiring('viewer'))

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

  useEffect(() => {
    if (!isDesktopHost()) return
    void setHostPlaybackAvailable(true).catch((error: unknown) =>
      console.error('Could not enable the desktop Playback menu', error),
    )
    return () => {
      void setHostPlaybackAvailable(false).catch((error: unknown) =>
        console.error('Could not disable the desktop Playback menu', error),
      )
    }
  }, [])
}
