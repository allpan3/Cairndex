import type { ReactNode } from 'react'
import { ContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry } from './useContextMenu'

/**
 * The library's Update button and its ⋯ menu, at the top of the sidebar where
 * v0.2.1 kept them. `children` is status that needs the owner, shown below them;
 * when nothing needs attention the sidebar shows only the two buttons.
 */
export function CatalogLibraryActions({
  update,
  items,
  children,
}: {
  /** Absent when this server cannot run Update for the library. */
  update?: { running: boolean; disabled: boolean; onClick: () => void }
  items: MenuEntry[]
  children?: ReactNode
}) {
  const menu = useContextMenu()
  return (
    <>
      <div className="sidebar__jobs" role="group" aria-label="Library actions">
        {update && (
          <button
            className="sidebar__job"
            disabled={update.disabled}
            onClick={update.onClick}
            title="Find new, moved and missing files in this library"
          >
            <span aria-hidden="true">⟳ </span>
            {update.running ? 'Updating…' : 'Update'}
          </button>
        )}
        <button
          // Alone, the menu button takes the row and says what it is
          className={update ? 'sidebar__job-more' : 'sidebar__job'}
          aria-label="More library actions"
          title="More library actions"
          aria-haspopup="menu"
          aria-expanded={menu.state !== null}
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect()
            menu.open(event, items, { x: box.left, y: box.bottom + 4 })
          }}
        >
          {update ? '⋯' : 'Library actions ⋯'}
        </button>
      </div>
      {children}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </>
  )
}
