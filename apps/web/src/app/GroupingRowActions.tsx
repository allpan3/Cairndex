import { createPortal } from 'react-dom'

import { IconMore } from './icons'
import { usePopover } from './usePopover'

/** One named thing this row can do. */
export interface RowAction {
  key: string
  label: string
  onSelect: () => void
  disabled?: boolean
}

/**
 * Collect a row's low-frequency edits behind one named menu.
 *
 * These were four icon-only buttons — a refresh glyph, an ungroup glyph, and a
 * `>< <>` pair — rendered inline after variable-length text, so they landed at
 * a different x on every row and nothing could be scanned down the list. They
 * were also discoverable only by hovering for a tooltip, which is a poor way to
 * find an action you do not already know exists.
 *
 * A single trigger at a fixed right edge fixes the scanning problem, and naming
 * the items in the menu removes the need for the tooltips entirely: "Make this
 * a collection of bundles instead" says what the ungroup glyph meant.
 *
 * Renders nothing when the row has no actions, rather than an inert trigger.
 */
export function GroupingRowActions({ label, actions }: { label: string; actions: RowAction[] }) {
  const { ref, panelRef, open, setOpen, pos } = usePopover()
  if (actions.length === 0) return null

  return (
    <span className="grp-actions" ref={ref}>
      <button
        type="button"
        className="grp-actions__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        draggable={false}
        data-no-row-drag=""
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          setOpen((value) => !value)
        }}
      >
        <IconMore />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            className="picker__panel grp-actions__menu"
            ref={panelRef}
            role="menu"
            aria-label={label}
            style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                className="grp-actions__item"
                role="menuitem"
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false)
                  action.onSelect()
                }}
              >
                {action.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </span>
  )
}
