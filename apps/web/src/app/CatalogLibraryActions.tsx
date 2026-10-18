import { ContextMenu } from './ContextMenu'
import { useContextMenu, type MenuEntry } from './useContextMenu'

/**
 * The library's Update button and its ⋯ menu, at the top of the sidebar where
 * v0.2.1 kept them. Their progress and status sit in the sidebar footer, as
 * v0.2.1's job rows did.
 */
export function CatalogLibraryActions({
  update,
  items,
}: {
  /** Absent when this server cannot run Update for the library. */
  update?: { running: boolean; disabled: boolean; onClick: () => void }
  items: MenuEntry[]
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
      <ContextMenu state={menu.state} onClose={menu.close} />
    </>
  )
}
