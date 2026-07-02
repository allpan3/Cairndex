/** Return `ids` with `dragId` removed and re-inserted immediately before
 * `targetId` (drag-to-reorder within one list). No-op if either id is missing or
 * they're the same. Shared by the collection tree/grid and the bundle grid. */
export function moveBefore(ids: string[], dragId: string, targetId: string): string[] {
  if (dragId === targetId) return ids
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  if (from === -1 || to === -1) return ids
  const next = ids.filter((id) => id !== dragId)
  next.splice(next.indexOf(targetId), 0, dragId)
  return next
}
