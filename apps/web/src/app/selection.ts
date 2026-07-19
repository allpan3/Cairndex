/**
 * The set to act on for an action targeting `id` (context menu, drag-out): the
 * whole current selection when `id` is part of a multi-selection, otherwise just
 * `id` itself. Callers apply any further filtering (e.g. files-only) themselves.
 */
export function selectionTargets<T>(id: T, selected: ReadonlySet<T>): T[] {
  return selected.has(id) && selected.size > 1 ? [...selected] : [id]
}
