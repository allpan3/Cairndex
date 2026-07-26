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

/** The collection a moved block should land in front of, named from the row it
 *  was dropped on and which edge: the leading edge is the gap before that row,
 *  the trailing edge the gap before whatever follows it (null = end of group).
 *  Members of the block are skipped — naming one would describe the gap by a row
 *  that is about to leave it. */
export function gapBefore(
  order: string[],
  moved: string[],
  overId: string,
  zone: 'before' | 'after',
): string | null {
  const index = order.indexOf(overId)
  if (index < 0) return null
  for (let at = zone === 'before' ? index : index + 1; at < order.length; at++) {
    const candidate = order[at]
    if (candidate !== undefined && !moved.includes(candidate)) return candidate
  }
  return null
}
