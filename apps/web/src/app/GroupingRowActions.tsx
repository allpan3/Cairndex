import { type KeyboardEvent, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'

import { IconMore } from './icons'
import { usePopover } from './usePopover'

/** Move focus among the menu's items, per the WAI-ARIA menu pattern.
 *
 * `role="menu"` promises this; without it the menu was reachable only by
 * tabbing past the whole dialog, because the panel is portalled to
 * `document.body` and so sits after the modal in document order.
 */
function moveItemFocus(event: KeyboardEvent<HTMLButtonElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const panel = event.currentTarget.closest('.grp-actions__menu')
  const items = [...(panel?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])]
  if (items.length === 0) return
  const current = Math.max(0, items.indexOf(event.currentTarget))
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : Math.max(0, Math.min(items.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))
  event.preventDefault()
  items[next]?.focus()
}

/** One named thing this row can do. */
export interface RowAction {
  key: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Why this is unavailable, shown when `disabled`. */
  reason?: string
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
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  // Focus the first item on open, and put focus back on the trigger when the
  // menu closes — otherwise a keyboard user opened a menu they could not reach
  // and, on Escape, was left with focus nowhere.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      panelRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    } else if (wasOpen.current) {
      wasOpen.current = false
      triggerRef.current?.focus()
    }
  }, [open, panelRef])

  // Never absent. A row whose actions are all unavailable used to render no
  // trigger at all, which read as "the feature was removed" rather than "not
  // here" — the owner could not tell the difference (owner-reported,
  // 2026-08-13). An empty menu says so instead.

  return (
    <span className="grp-actions" ref={ref}>
      <button
        ref={triggerRef}
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
            // maxHeight matters: `.picker__panel` is `overflow-y: auto` and its
            // own comment says the bound is set inline from usePopover. Every
            // other consumer passes it; without it a menu opened near the
            // viewport edge is neither clamped nor scrollable.
            style={{
              top: pos.top,
              bottom: pos.bottom,
              right: pos.right,
              maxHeight: pos.maxHeight,
            }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {actions.length === 0 && (
              <p className="grp-actions__empty">No edits available for this row</p>
            )}
            {actions.map((action) => (
              <button
                key={action.key}
                type="button"
                className="grp-actions__item"
                role="menuitem"
                disabled={action.disabled}
                // Named, because a disabled item otherwise says only that it is
                // unavailable — the wrapper the deleted tooltip used existed
                // precisely so an endpoint could explain itself.
                title={action.reason ?? action.label}
                onKeyDown={moveItemFocus}
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
