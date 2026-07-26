/**
 * The set to act on for an action targeting `id` (context menu, drag-out): the
 * whole current selection when `id` is part of a multi-selection, otherwise just
 * `id` itself. Callers apply any further filtering (e.g. files-only) themselves.
 */
export function selectionTargets<T>(id: T, selected: ReadonlySet<T>): T[] {
  return isMultiSelection(selected) && selected.has(id) ? [...selected] : [id]
}

/** Whether more than one item is selected — the "act on the whole selection"
 * condition, shared by the target rule above and multi-selection UI. */
export function isMultiSelection<T>(selected: ReadonlySet<T>): boolean {
  return selected.size > 1
}

/**
 * Stops a Shift-click from painting a text selection across the listing.
 *
 * Shift-click means "extend the *item* range", but the browser also reads it as
 * "extend the text selection from wherever the anchor last was" — and WebKit
 * paints that sweep even across `user-select: none` content, so range-selecting
 * bundles highlighted every label in between. Attached with `capture` on the
 * listing container so it runs for clicks on items as well as background, and
 * skipped inside editors, where Shift-selection of text is the point.
 */
export function suppressShiftSelection(e: React.MouseEvent): void {
  if (!e.shiftKey) return
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, [contenteditable="true"]')) return
  e.preventDefault()
  globalThis.getSelection?.()?.removeAllRanges()
}
