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
 * but on their own curve: smaller, and topping out around the slider's midpoint
 * (~half the bundle range) so folders never grow as large as bundle tiles. Below
 * ZOOM_MIN..midpoint they ramp from MIN to MAX, then hold at MAX. */
export function collectionCardWidth(zoom: number): number {
  const MIN = 72
  const MAX = 180
  const start = ZOOM_MIN
  const midpoint = (ZOOM_MIN + ZOOM_MAX) / 2 // reach MAX around the slider middle
  const t = Math.max(0, Math.min(1, (zoom - start) / (midpoint - start)))
  return Math.round(MIN + t * (MAX - MIN))
}

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
