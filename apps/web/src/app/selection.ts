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
