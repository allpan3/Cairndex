// Pure drag-reorder logic for the All Tags page, split out so the component file
// stays component-only (react-refresh) and this stays unit-testable without DnD.

export interface ReorderTarget {
  tag: { id: string }
  // The sibling group key: parent id, `group:<id>`, or null at the hierarchy root.
  parentKey: string | null
}

export type ReorderPlan =
  | { kind: 'siblings'; parentId: string | null; orderedIds: string[] }
  | { kind: 'group'; groupId: string; orderedIds: string[] }

/** New sibling order after dragging `dragId` onto `targetId` — insert after when
 * dragging down, before when dragging up (natural drag semantics). */
export function moveWithin(order: string[], dragId: string, targetId: string): string[] {
  const from = order.indexOf(dragId)
  const to = order.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return order
  const without = order.filter((id) => id !== dragId)
  const ti = without.indexOf(targetId)
  without.splice(from < to ? ti + 1 : ti, 0, dragId)
  return without
}

/**
 * Decide the reorder to apply when `dragId` is dropped on `target`, or null when
 * the drop is invalid. Reorders among siblings only: the drag source and target
 * must share a sibling group — never reparent (no dragging a child out of its
 * parent).
 */
export function planReorder(opts: {
  dragId: string
  target: ReorderTarget
  groupId: string | null
  parentOf: (id: string) => string | null | undefined
  hasTag: (id: string) => boolean
  siblingIds: string[]
  groupOrder: string[]
}): ReorderPlan | null {
  const { dragId, target, groupId, parentOf, hasTag, siblingIds, groupOrder } = opts
  if (dragId === target.tag.id) return null
  const srcParent = parentOf(dragId)
  const srcKey = groupId ? `group:${groupId}` : srcParent && hasTag(srcParent) ? srcParent : null
  if (srcKey !== target.parentKey) return null
  if (groupId) {
    return { kind: 'group', groupId, orderedIds: moveWithin(groupOrder, dragId, target.tag.id) }
  }
  return {
    kind: 'siblings',
    parentId: target.parentKey,
    orderedIds: moveWithin(siblingIds, dragId, target.tag.id),
  }
}
