/** Return `ids` with `dragId` removed and re-inserted just before (`before`) or
 * just after the `overId` slot — the gap-insertion model (drop *between* items,
 * not onto them). No-op if either id is missing. Shared by the collection
 * tree/grid and the bundle grid. */
export function moveTo(ids: string[], dragId: string, overId: string, before: boolean): string[] {
  return moveManyTo(ids, [dragId], overId, before)
}

/** `moveTo` for a whole dragged set: the moved ids land together as one block at
 * the gap, keeping their existing relative order (so a multi-selection dropped
 * elsewhere doesn't come out shuffled). Ids not present in `ids` are ignored;
 * dropping a block onto its own member is a no-op. */
export function moveManyTo(
  ids: string[],
  dragIds: string[],
  overId: string,
  before: boolean,
): string[] {
  const moving = ids.filter((id) => dragIds.includes(id))
  if (moving.length === 0 || !ids.includes(overId) || moving.includes(overId)) return ids
  const without = ids.filter((id) => !moving.includes(id))
  const at = without.indexOf(overId) + (before ? 0 : 1)
  without.splice(at, 0, ...moving)
  return without
}
