/**
 * Row-aware arrow-key movement over a grid of items.
 *
 * Moving by one position in the ordered list is right for Left/Right — at the
 * end of a row it wraps to the next, the way a file manager does — but it makes
 * Up/Down mean "previous/next item", so in a grid they moved sideways instead of
 * up and down (owner, 2026-09-01). Vertical movement therefore asks the layout
 * rather than the list: it reads where the items actually are.
 *
 * Geometry, not layout knowledge, so one function serves the card grid, the
 * justified grid, the list views, and the folder cards above a grid — including
 * moving between those two sections, which are one plane on screen.
 */
export interface NavTarget {
  id: string
  rect: { top: number; bottom: number; left: number; right: number }
}

/** Two items share a row when they overlap vertically by more than half the
 *  shorter one — tolerant of a justified row's unequal tile heights. */
function sameRow(a: NavTarget['rect'], b: NavTarget['rect']): boolean {
  const overlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  const shorter = Math.min(a.bottom - a.top, b.bottom - b.top)
  return shorter > 0 && overlap > shorter / 2
}

function centerX(rect: NavTarget['rect']): number {
  return (rect.left + rect.right) / 2
}

/**
 * The id one row above or below `currentId`, or null when there is no such row
 * among the targets (the caller then falls back to its ordered neighbour, which
 * is what carries movement past the edge of a virtualized window).
 */
export function rowStep(
  targets: NavTarget[],
  currentId: string | null,
  direction: 'up' | 'down',
): string | null {
  const current = targets.find((target) => target.id === currentId)
  if (!current) return null
  // Nothing measurable to reason about — an unlaid-out document (jsdom), or a
  // hidden container. Null hands the move back to the caller's ordered step,
  // which is the same answer this used to give everywhere.
  if (current.rect.bottom - current.rect.top <= 0) return null

  // Every item on another row, in the direction asked for.
  const candidates = targets.filter((target) => {
    if (target.id === current.id || sameRow(current.rect, target.rect)) return false
    return direction === 'down'
      ? target.rect.top >= current.rect.bottom - (current.rect.bottom - current.rect.top) / 2
      : target.rect.bottom <= current.rect.top + (current.rect.bottom - current.rect.top) / 2
  })
  if (candidates.length === 0) return null

  // The nearest row in that direction…
  const nearest = candidates.reduce((best, target) => {
    const distance =
      direction === 'down'
        ? target.rect.top - current.rect.bottom
        : current.rect.top - target.rect.bottom
    const bestDistance =
      direction === 'down'
        ? best.rect.top - current.rect.bottom
        : current.rect.top - best.rect.bottom
    return distance < bestDistance ? target : best
  })
  // …then, within it, the item closest to the column being travelled down.
  // `nearest` is always part of its own row, whatever `sameRow` makes of a
  // degenerate rect — otherwise the reduce below could run on an empty list.
  const row = candidates.filter(
    (target) => target.id === nearest.id || sameRow(nearest.rect, target.rect),
  )
  const column = centerX(current.rect)
  return row.reduce((best, target) =>
    Math.abs(centerX(target.rect) - column) < Math.abs(centerX(best.rect) - column) ? target : best,
  ).id
}

/** Read the rendered targets for a set of selectors, in document order. */
export function navTargetsFrom(
  root: ParentNode,
  selector: string,
  idOf: (el: HTMLElement) => string | undefined,
): NavTarget[] {
  const targets: NavTarget[] = []
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    const id = idOf(element)
    if (id === undefined) continue
    targets.push({ id, rect: element.getBoundingClientRect() })
  }
  return targets
}
