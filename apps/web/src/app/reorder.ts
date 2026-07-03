/** Return `ids` with `dragId` removed and re-inserted just before (`before`) or
 * just after the `overId` slot — the gap-insertion model (drop *between* items,
 * not onto them). No-op if either id is missing. Shared by the collection
 * tree/grid and the bundle grid. */
export function moveTo(ids: string[], dragId: string, overId: string, before: boolean): string[] {
  if (dragId === overId) return ids
  if (!ids.includes(dragId) || !ids.includes(overId)) return ids
  const without = ids.filter((id) => id !== dragId)
  const at = without.indexOf(overId) + (before ? 0 : 1)
  without.splice(at, 0, dragId)
  return without
}
