// Pure drag-reorder logic for the All Tags page, split out so the component file
// stays component-only (react-refresh) and this stays unit-testable without DnD.

export interface ReorderTarget {
  tag: { id: string }
  // The sibling group key: parent id, `group:<id>`, or null at the hierarchy root.
  parentKey: string | null
}

// Which side of the target row the dragged tag drops onto (from the cursor's
// position over the row). Drives both the insertion and the drop-line indicator.
export type DropPosition = 'before' | 'after'

export type ReorderPlan =
  | { kind: 'siblings'; parentId: string | null; orderedIds: string[] }
  | { kind: 'group'; groupId: string; orderedIds: string[] }

/** New order after moving `dragId` to just before/after `targetId`. */
export function moveTo(
  order: string[],
  dragId: string,
  targetId: string,
  position: DropPosition,
): string[] {
  const without = order.filter((id) => id !== dragId)
  const ti = without.indexOf(targetId)
  if (ti < 0) return order
  without.splice(position === 'after' ? ti + 1 : ti, 0, dragId)
  return without
}

/** The sibling-group key of a tag: its parent id when the parent is in view, else
 * the hierarchy root (null); or the group when scoped to a group. Reorder is
 * constrained to a single sibling group — this is how "same siblings" is decided. */
export function siblingKeyOf(
  id: string,
  groupId: string | null,
  parentOf: (id: string) => string | null | undefined,
  hasTag: (id: string) => boolean,
): string | null {
  if (groupId) return `group:${groupId}`
  const parent = parentOf(id)
  return parent && hasTag(parent) ? parent : null
}

/**
 * Decide the reorder to apply when `dragId` is dropped `position` a `target`, or
 * null when the drop is invalid. Reorders among siblings only: the drag source
 * and target must share a sibling group — never reparent (no dragging a child out
 * of its parent).
 */
export function planReorder(opts: {
  dragId: string
  target: ReorderTarget
  position: DropPosition
  groupId: string | null
  parentOf: (id: string) => string | null | undefined
  hasTag: (id: string) => boolean
  siblingIds: string[]
  groupOrder: string[]
}): ReorderPlan | null {
  const { dragId, target, position, groupId, parentOf, hasTag, siblingIds, groupOrder } = opts
  if (dragId === target.tag.id) return null
  if (siblingKeyOf(dragId, groupId, parentOf, hasTag) !== target.parentKey) return null
  if (groupId) {
    return {
      kind: 'group',
      groupId,
      orderedIds: moveTo(groupOrder, dragId, target.tag.id, position),
    }
  }
  return {
    kind: 'siblings',
    parentId: target.parentKey,
    orderedIds: moveTo(siblingIds, dragId, target.tag.id, position),
  }
}
