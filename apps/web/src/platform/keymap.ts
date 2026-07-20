import keymapJson from './keymap.json'

/**
 * Typed access to the canonical shortcut table (`keymap.json`).
 *
 * That file is the single source of truth for the native menu bar: the Tauri
 * shell embeds it at compile time and builds the menu from it, while this module
 * gives the SPA the same data for action typing and the shortcut reference.
 * Keeping one table is plan 3 §7's requirement.
 */
export interface KeymapItem {
  id?: string
  label?: string
  accelerator?: string | null
  /** Names a Tauri built-in item; such entries have no id of their own. */
  predefined?: string
  separator?: boolean
  /** Enablement group: 'server' | 'library' | 'viewer' | 'never' | null. */
  requires?: string | null
  /** True when a browser intercepts this accelerator before the page sees it. */
  browserReserved?: boolean
  /** Bare-key bindings the web app handles itself in the focused viewer. */
  keys?: string[]
  /** True when the shell handles the item instead of emitting an SPA action. */
  native?: boolean
}

export interface KeymapMenu {
  id: string
  label: string
  items: KeymapItem[]
}

export const keymapMenus: KeymapMenu[] = (keymapJson as { menus: KeymapMenu[] }).menus

/** True when this entry dispatches a semantic action to the SPA. */
function dispatchesToSpa(item: KeymapItem): boolean {
  return (
    item.id !== undefined &&
    item.native !== true &&
    item.separator !== true &&
    item.predefined === undefined &&
    item.requires !== 'never'
  )
}

/** Every menu id the shell can emit as an SPA action. */
export function dispatchableActionIds(): string[] {
  return keymapMenus.flatMap((menu) =>
    menu.items.filter(dispatchesToSpa).map((item) => item.id as string),
  )
}

/** Ids in one enablement group, e.g. the Playback menu's `viewer` group. */
export function actionIdsRequiring(group: string): string[] {
  return keymapMenus.flatMap((menu) =>
    menu.items
      .filter((item) => item.requires === group && item.id)
      .map((item) => item.id as string),
  )
}

/** Flattened table for a user-facing shortcut reference. */
export function shortcutReference(): Array<{
  menu: string
  label: string
  accelerator: string | null
  keys: string[]
  browserReserved: boolean
}> {
  return keymapMenus.flatMap((menu) =>
    menu.items
      .filter((item) => item.label !== undefined && !item.separator)
      .map((item) => ({
        menu: menu.label,
        label: item.label as string,
        accelerator: item.accelerator ?? null,
        keys: item.keys ?? [],
        browserReserved: item.browserReserved === true,
      })),
  )
}
