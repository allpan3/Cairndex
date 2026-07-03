/** Hierarchy guide rails for a tree row, Eagle-style: a thin vertical rule per
 * ancestor level plus an elbow connector that bends into the row's own icon and
 * stops at the last child of a group.
 *
 * `trail` carries, for each ancestor column (length = depth - 1), whether that
 * ancestor has a following sibling — so its vertical line should continue past
 * this subtree. `isLast` marks the row as the last of its siblings, so the
 * connector draws "└" (stops at the row centre) instead of "├".
 *
 * The lines are centred in each rail cell, and the rail width matches the row's
 * indent step, so every vertical line lands on the centre of its parent's icon.
 * Passing only `depth` (no `trail`) keeps the old plain-indent behaviour.
 */
export function PickGuides({
  depth,
  trail,
  isLast = false,
}: {
  depth: number
  trail?: boolean[]
  isLast?: boolean
}) {
  if (depth <= 0) return null
  // Back-compat: without an explicit trail, treat every ancestor line as
  // continuing (a plain indent grid, no elbow).
  const ancestors = trail ?? Array.from({ length: depth - 1 }, () => true)
  return (
    <span className="pick-guides" aria-hidden>
      {ancestors.map((cont, i) => (
        <span key={i} className={`pick-guide${cont ? ' pick-guide--line' : ''}`} />
      ))}
      <span className={`pick-guide pick-guide--elbow${isLast ? ' pick-guide--last' : ''}`} />
    </span>
  )
}
