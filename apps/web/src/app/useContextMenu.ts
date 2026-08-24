import { useState } from 'react'

import { dropRightClickSelection } from './selection'

/** One row in a right-click menu. A `null` entry renders a separator. */
export interface MenuItem {
  label: string
  onClick: () => void
  /** Render in the destructive (red) style, e.g. delete actions. */
  danger?: boolean
  disabled?: boolean
}

export type MenuEntry = MenuItem | null

export interface MenuState {
  x: number
  y: number
  items: MenuEntry[]
}

/**
 * Right-click menu state shared by a surface (cards, sidebar rows, …).
 *
 * `open` captures the cursor position and the menu's items from a
 * `contextmenu` event; `close` dismisses it. Rendering is done by dropping a
 * single `<ContextMenu>` next to the surface and feeding it `state`/`close`.
 */
export function useContextMenu() {
  const [state, setState] = useState<MenuState | null>(null)
  const open = (e: React.MouseEvent, items: MenuEntry[]) => {
    e.preventDefault()
    // WebKit selected the word under the cursor on the way here; the menu that
    // replaces the native one has no use for it. Done before the empty-menu
    // bail-out below, because the stray highlight is just as wrong on a surface
    // whose menu turned out to have nothing to offer.
    dropRightClickSelection(e.target)
    // An all-disabled or empty menu would just be an empty box — skip it.
    if (!items.some((i) => i && !i.disabled)) return
    setState({ x: e.clientX, y: e.clientY, items })
  }
  const close = () => setState(null)
  return { state, open, close }
}
