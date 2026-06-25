import type { BundleSummary } from '../api/client'
import type { LayoutMode } from './types'

export interface PlacedCard {
  item: BundleSummary
  x: number
  width: number
}

export interface Row {
  height: number
  cards: PlacedCard[]
}

const GAP = 10
const META_HEIGHT = 44 // title + sub line under a grid card
export const LIST_ROW_HEIGHT = 40

function aspect(item: BundleSummary): number {
  if (item.width && item.height) return item.width / item.height
  return 16 / 9
}

/** Pack bundle summaries into virtualizable rows for the given layout. */
export function computeRows(
  items: BundleSummary[],
  layout: LayoutMode,
  containerWidth: number,
  zoom: number,
): Row[] {
  if (containerWidth <= 0 || items.length === 0) return []

  if (layout === 'list') {
    return items.map((item) => ({
      height: LIST_ROW_HEIGHT,
      cards: [{ item, x: 0, width: containerWidth }],
    }))
  }

  if (layout === 'grid') {
    const cardW = zoom
    const cols = Math.max(1, Math.floor((containerWidth + GAP) / (cardW + GAP)))
    const actualW = (containerWidth - (cols - 1) * GAP) / cols
    const cardH = actualW * 0.62 + META_HEIGHT
    const rows: Row[] = []
    for (let i = 0; i < items.length; i += cols) {
      const slice = items.slice(i, i + cols)
      rows.push({
        height: cardH + GAP,
        cards: slice.map((item, j) => ({ item, x: j * (actualW + GAP), width: actualW })),
      })
    }
    return rows
  }

  // Justified: fixed-ish target row height, scale each row to fill the width.
  const targetH = zoom * 0.6
  const rows: Row[] = []
  let current: BundleSummary[] = []
  let aspectSum = 0

  const flush = (isLast: boolean) => {
    if (current.length === 0) return
    const totalGap = GAP * (current.length - 1)
    let rowH = (containerWidth - totalGap) / aspectSum
    if (isLast) rowH = Math.min(rowH, targetH * 1.3)
    let x = 0
    const cards: PlacedCard[] = current.map((item) => {
      const w = rowH * aspect(item)
      const card = { item, x, width: w }
      x += w + GAP
      return card
    })
    rows.push({ height: rowH + GAP, cards })
    current = []
    aspectSum = 0
  }

  for (const item of items) {
    current.push(item)
    aspectSum += aspect(item)
    if (aspectSum * targetH + GAP * (current.length - 1) >= containerWidth) {
      flush(false)
    }
  }
  flush(true)
  return rows
}
