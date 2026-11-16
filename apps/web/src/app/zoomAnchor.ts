import type { Row } from './layout'

/** A point in the grid's own coordinates: rows from its top, cards from its left. */
export interface GridPoint {
  x: number
  y: number
}

/**
 * The centre of one item's card, or null when the layout does not hold it.
 * `gap` is the part of each row's height below its cards (none in a list).
 */
export function cardCentre(rows: Row[], rowTops: number[], id: string, gap = 0): GridPoint | null {
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const card = row.cards.find((item) => item.item.id === id)
    if (card)
      return { x: card.x + card.width / 2, y: (rowTops[index] ?? 0) + (row.height - gap) / 2 }
  }
  return null
}

/**
 * The item a zoom keeps in place: the active item while it is in view, else the
 * one nearest the middle of the view. `top` and `bottom` bound the view in grid
 * coordinates; `width` is the grid's width.
 */
export function zoomAnchor(
  rows: Row[],
  rowTops: number[],
  view: { top: number; bottom: number; width: number },
  activeId: string | null,
): string | null {
  if (activeId) {
    const centre = cardCentre(rows, rowTops, activeId)
    if (centre && centre.y >= view.top && centre.y <= view.bottom) return activeId
  }
  const middle = { x: view.width / 2, y: (view.top + view.bottom) / 2 }
  let best: { id: string; dy: number; dx: number } | null = null
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!
    const top = rowTops[index] ?? 0
    if (top > view.bottom) break
    if (top + row.height < view.top) continue
    const dy = Math.abs(top + row.height / 2 - middle.y)
    for (const card of row.cards) {
      const dx = Math.abs(card.x + card.width / 2 - middle.x)
      if (!best || dy < best.dy || (dy === best.dy && dx < best.dx))
        best = { id: card.item.id, dy, dx }
    }
  }
  return best?.id ?? null
}
