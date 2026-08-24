import type { ViewerCommand } from '../app/viewer/player/useShortcuts'

/**
 * Actions the native menu can dispatch to the SPA. These must stay in exact sync
 * with the dispatchable ids in `platform/keymap.json` (the shell builds its menu
 * from that table); `platform/keymap.test.ts` pins the two together.
 */
export type DesktopWorkspaceAction =
  | 'reload'
  | 'settings'
  | 'manage-libraries'
  | 'pair-device'
  | 'new-bundle'
  | 'new-collection'
  | 'add-files'
  | 'show-bundles'
  | 'show-files'
  | 'zoom-in'
  | 'zoom-out'
  | 'toggle-sidebar'
  | 'toggle-inspector'
  | 'reveal-file'
  | 'open-file'

/** Playback menu items are routed to the open viewer rather than the workspace. */
export type DesktopPlaybackAction = ViewerCommand

export type DesktopMenuAction = DesktopWorkspaceAction | DesktopPlaybackAction
