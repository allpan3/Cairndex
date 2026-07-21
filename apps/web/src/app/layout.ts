import type { LayoutMode } from './types'

/** Minimum geometry needed to place an item in grid and justified layouts */
export interface LayoutItem {
  width: number | null
  height: number | null
}

/** One item positioned inside a computed layout row */
export interface PlacedCard<T extends LayoutItem> {
  item: T
  x: number
  width: number
}

/** One computed row shared by bundle and in-bundle file views */
export interface Row<T extends LayoutItem> {
  height: number
  cards: PlacedCard<T>[]
}

/** Optional media and metadata heights for surfaces with different card chrome */
export interface LayoutGeometry {
  gridMediaHeightRatio?: number
  gridMetaHeight?: number
  justifiedMetaHeight?: number
}

const GAP = 10
const META_HEIGHT = 44 // title + sub line under a grid card

// Shared zoom-slider bounds (a grid bundle card's target width in px). The floor
// is deliberately small so both bundle and folder cards can shrink further than
// before; folder cards remap this range onto their own smaller curve.
export const ZOOM_MIN = 80
export const ZOOM_MAX = 360

/** Map the shared zoom (a grid card's target width) to a list row height, so the
 * one zoom slider drives both layouts. Default zoom 200 → 40px (the previous
 * fixed row height); clamped to a comfortable 34–72px range. */
export function listRowHeight(zoom: number): number {
  return Math.round(Math.max(34, Math.min(72, zoom * 0.2)))
}

/** Folder (collection) cards scale off the *same* zoom slider as bundle cards
 * but on their own curve: smaller, and topping out partway along the slider so
 * folders never grow as large as the biggest bundle tiles. Below
 * ZOOM_MIN..capAt they ramp from MIN to MAX, then hold at MAX.
 *
 * Knobs to experiment with: MIN/MAX are the folder card's px width range, and
 * COLLECTION_CAP_FRACTION is where along the slider it reaches MAX (2/3 here). */
export const COLLECTION_CARD_MIN = 96
export const COLLECTION_CARD_MAX = 300
const COLLECTION_CAP_FRACTION = 3 / 3
export function collectionCardWidth(zoom: number): number {
  const start = ZOOM_MIN
  const capAt = ZOOM_MIN + (ZOOM_MAX - ZOOM_MIN) * COLLECTION_CAP_FRACTION
  const t = Math.max(0, Math.min(1, (zoom - start) / (capAt - start)))
  return Math.round(COLLECTION_CARD_MIN + t * (COLLECTION_CARD_MAX - COLLECTION_CARD_MIN))
}

/** Return a usable aspect ratio even before technical metadata exists */
function aspect(item: LayoutItem): number {
  if (item.width && item.height) return item.width / item.height
  return 16 / 9
}

/** Pack items into virtualizable rows for the given layout */
export function computeRows<T extends LayoutItem>(
  items: T[],
  layout: LayoutMode,
  containerWidth: number,
  zoom: number,
  geometry: LayoutGeometry = {},
): Row<T>[] {
  if (containerWidth <= 0 || items.length === 0) return []

  if (layout === 'list') {
    const rowH = listRowHeight(zoom)
    return items.map((item) => ({
      height: rowH,
      cards: [{ item, x: 0, width: containerWidth }],
    }))
  }

  if (layout === 'grid') {
    const cardW = zoom
    const cols = Math.max(1, Math.floor((containerWidth + GAP) / (cardW + GAP)))
    const actualW = (containerWidth - (cols - 1) * GAP) / cols
    const cardH =
      actualW * (geometry.gridMediaHeightRatio ?? 0.62) + (geometry.gridMetaHeight ?? META_HEIGHT)
    const rows: Row<T>[] = []
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
  const rows: Row<T>[] = []
  let current: T[] = []
  let aspectSum = 0

  const flush = (isLast: boolean) => {
    if (current.length === 0) return
    const totalGap = GAP * (current.length - 1)
    let rowH = (containerWidth - totalGap) / aspectSum
    if (isLast) rowH = Math.min(rowH, targetH * 1.3)
    let x = 0
    const cards: PlacedCard<T>[] = current.map((item) => {
      const w = rowH * aspect(item)
      const card = { item, x, width: w }
      x += w + GAP
      return card
    })
    rows.push({ height: rowH + (geometry.justifiedMetaHeight ?? 0) + GAP, cards })
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
