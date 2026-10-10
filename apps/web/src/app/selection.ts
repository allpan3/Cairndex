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
  if (target.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return
  e.preventDefault()
  globalThis.getSelection?.()?.removeAllRanges()
}

/**
 * Drops the text selection a right-click made on its way to opening a menu.
 *
 * WebKit selects the word under the cursor when a context menu opens — Chromium
 * does not — so in the desktop shell every right-click left a highlighted word
 * (or the fragment of one it landed in) behind on a card title, a sidebar row, a
 * tag tile (owner, 2026-08-23). Nothing ever acts on it: the surfaces that open
 * a menu also prevent the native one, and none of our menus has a Copy item, so
 * the highlight is debris from a gesture that meant "act on this row".
 *
 * Called from `useContextMenu.open`, which is the one place every custom menu in
 * the app passes through — so this covers every such surface, current and
 * future, without a list of them to keep in step. Surfaces with no custom menu
 * are deliberately left alone: there the native menu *does* appear, and clearing
 * the selection first would strip its Copy and Look Up entries.
 *
 * Skipped inside a text field, where the caret and any selection are the point.
 */
export function dropRightClickSelection(target: EventTarget | null): void {
  const element = target instanceof Element ? target : null
  if (element?.closest('input, textarea, [contenteditable]:not([contenteditable="false"])')) return
  globalThis.getSelection?.()?.removeAllRanges()
}
// Pointer and keyboard selection share modifier and anchor rules
export type SelectionModifiers = Pick<React.MouseEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>

// Resolve an inclusive range in loaded order, retaining existing items for additive selection
export function selectionRange(
  ids: string[],
  anchor: string | null,
  target: string,
  base: ReadonlySet<string> = new Set(),
): Set<string> {
  const end = ids.indexOf(target)
  if (end < 0) return new Set(base)
  const found = anchor === null ? -1 : ids.indexOf(anchor)
  const start = found < 0 ? end : found
  return new Set([...base, ...ids.slice(Math.min(start, end), Math.max(start, end) + 1)])
}

// Clicking listing content establishes keyboard ownership without moving a text caret
export function focusListing(event: React.MouseEvent<HTMLElement>): void {
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
    return
  if (target?.closest('button, a') && !target.closest('[data-collection-id], [data-relpath]'))
    return
  event.currentTarget.focus({ preventScroll: true })
  suppressShiftSelection(event)
}

// Editors, modal overlays and nested controls retain their own keyboard commands
export function listingOwnsKey(event: KeyboardEvent, root: HTMLElement | null): boolean {
  if (event.defaultPrevented || !root) return false
  const target = event.target instanceof Element ? event.target : document.activeElement
  if (!target || !root.contains(target)) return false
  if (
    target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="menu"]',
    )
  )
    return false
  if (target.closest('button, a') && !target.closest('[data-collection-id], [data-relpath]'))
    return false
  return !Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"]')).some(
    (dialog) => !dialog.matches('dialog:not([open])') && !dialog.contains(root),
  )
}
