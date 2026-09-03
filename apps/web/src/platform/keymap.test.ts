import { describe, expect, it } from 'vitest'

import type { ViewerCommand } from '../app/viewer/player/useShortcuts'
import type { DesktopMenuAction, DesktopWorkspaceAction } from '../desktop/types'
import { actionIdsRequiring, dispatchableActionIds, keymapMenus, shortcutReference } from './keymap'

// The shell builds its native menu from keymap.json, so these lists are the
// contract between the two. Declaring them explicitly (rather than deriving them
// from the same source) is the point: a table edit that is not mirrored in the
// SPA's action types fails here instead of producing a dead menu item.
const EXPECTED_WORKSPACE_ACTIONS: DesktopWorkspaceAction[] = [
  'reload',
  'settings',
  'manage-libraries',
  'pair-device',
  'new-bundle',
  'new-collection',
  'new-folder',
  'add-files',
  'show-bundles',
  'show-files',
  'zoom-in',
  'zoom-out',
  'toggle-sidebar',
  'toggle-inspector',
  'reveal-file',
  'open-file',
]

const EXPECTED_PLAYBACK_ACTIONS: ViewerCommand[] = [
  'play-pause',
  'previous-file',
  'next-file',
  'seek-back',
  'seek-forward',
  'rate-down',
  'rate-up',
  'toggle-mute',
  'toggle-subtitles',
  'snapshot',
]

describe('keymap table', () => {
  it('dispatches exactly the actions the SPA types declare', () => {
    const expected: DesktopMenuAction[] = [
      ...EXPECTED_WORKSPACE_ACTIONS,
      ...EXPECTED_PLAYBACK_ACTIONS,
    ]
    expect(dispatchableActionIds().sort()).toEqual([...expected].sort())
  })

  it('puts every viewer-gated action in the Playback menu', () => {
    const gated = [...actionIdsRequiring('viewer'), ...actionIdsRequiring('viewer-video')]
    expect(gated.sort()).toEqual([...EXPECTED_PLAYBACK_ACTIONS].sort())
  })

  it('gates player-only commands behind a video, not just an open viewer', () => {
    // An image bundle has no PlayerController. Only file navigation works there, so
    // the rest must sit in the stricter group or they render enabled-but-dead.
    expect(actionIdsRequiring('viewer')).toEqual(['previous-file', 'next-file'])
    expect(actionIdsRequiring('viewer-video')).toEqual(
      expect.arrayContaining(['play-pause', 'seek-back', 'toggle-mute', 'snapshot']),
    )
  })

  it('excludes shell-owned and placeholder items from SPA dispatch', () => {
    // `quit` is handled in Rust and the help entry is a disabled placeholder;
    // neither may reach the SPA as an action.
    expect(dispatchableActionIds()).not.toContain('quit')
    expect(dispatchableActionIds()).not.toContain('help-placeholder')
  })

  it('leaves Full Screen to the system item', () => {
    // AppKit inserts its own Enter Full Screen into the View menu unless the app
    // already owns one bound to toggleFullScreen:, so ours must be the predefined
    // item — a custom one produced two entries doing the same thing.
    const view = keymapMenus.find((menu) => menu.id === 'view-menu')
    const fullscreen = view?.items.find((item) => item.predefined === 'fullscreen')
    expect(fullscreen?.label).toBe('Enter Full Screen')
    expect(fullscreen?.accelerator).toBe('Ctrl+Cmd+F')
    expect(dispatchableActionIds()).not.toContain('fullscreen')
  })

  it('gives every non-separator item a label', () => {
    for (const menu of keymapMenus) {
      for (const item of menu.items) {
        if (item.separator || item.predefined) continue
        expect(item.label, `${menu.id} item ${item.id ?? '?'}`).toBeTruthy()
      }
    }
  })

  it('uses only modifier-based accelerators so typing is never swallowed', () => {
    // Accelerators are handled by the OS before the webview sees the key, so a
    // bare-key accelerator would intercept that letter inside every text field.
    for (const menu of keymapMenus) {
      for (const item of menu.items) {
        if (!item.accelerator) continue
        expect(item.accelerator, `${menu.id} ${item.label ?? ''}`).toMatch(
          /^(CmdOrCtrl|Cmd|Ctrl|Alt|Shift|Control)\+/,
        )
      }
    }
  })

  it('never reuses an accelerator', () => {
    const accelerators = keymapMenus
      .flatMap((menu) => menu.items)
      .map((item) => item.accelerator)
      .filter((value): value is string => Boolean(value))
    expect(new Set(accelerators).size).toBe(accelerators.length)
  })

  it('reports the browser-reserved combos the shell unlocks', () => {
    const reserved = shortcutReference()
      .filter((entry) => entry.browserReserved)
      .map((entry) => entry.accelerator)
    // These are the D5 shortcut audit's whole point: combos a browser intercepts
    // (tabs, devtools, history, new window) that only work in the shell.
    expect(reserved).toEqual(
      expect.arrayContaining([
        'CmdOrCtrl+1',
        'CmdOrCtrl+2',
        'CmdOrCtrl+N',
        'CmdOrCtrl+Shift+N',
        'CmdOrCtrl+[',
        'CmdOrCtrl+]',
        'CmdOrCtrl+S',
      ]),
    )
  })

  it('gives a Playback item an accelerator only when no viewer key covers it', () => {
    // Owner decision (2026-07-19): a global accelerator for a command that already
    // has a bare viewer key buys nothing, since these are reachable only with the
    // viewer open — and it permanently reserves that combo app-wide. So Playback
    // items carry an accelerator ONLY where the keyboard would otherwise be dead.
    const playback = keymapMenus.find((menu) => menu.id === 'playback-menu')
    expect(playback).toBeDefined()

    for (const item of playback?.items ?? []) {
      if (item.separator) continue
      const hasViewerKey = (item.keys ?? []).length > 0
      if (hasViewerKey) {
        expect(item.accelerator, `${item.label ?? ''} duplicates its viewer key`).toBeNull()
      }
    }

    // Previous/Next File are the exception that justifies the rule: with a video
    // loaded, Arrow keys mean seek, so these have no bare-key binding at all.
    const withAccelerator = (playback?.items ?? [])
      .filter((item) => item.accelerator)
      .map((item) => item.id)
    expect(withAccelerator).toEqual(['previous-file', 'next-file'])
  })
})
