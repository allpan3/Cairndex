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
// Room reserved under a Card-layout cover for its title + sub line, plus the
// card's 1px border. A reservation rather than a measurement: the frame's shape
// is CSS's (`.card--framed .card__thumb`), so a couple of spare pixels here show
// as card surface under the text, while too few would clip the title outright.
const META_HEIGHT = 44

/** Every card-layout tile's cover frame, as width ÷ height.
 *
 * One shape for all of them is the point of the layout — a grid of mixed shapes
 * is not a grid — so the question is only *which* shape. 16:9 is the answer
 * because the library is video: it means a 16:9 cover fills its frame exactly
 * and the black bars show up only on the covers that genuinely are not 16:9
 * (owner, 2026-08-23). It was 1.61:1 before, which put bars on everything. The
 * justified layout is the one that shapes each tile to its own cover instead. */
export const CARD_COVER_ASPECT = 16 / 9

// Shared zoom-slider bounds (a card's target width in px). Shifted up twice on
// the same day, 80–360 → 120–480 → this: the smallest cards were too small to
// read and the largest not large enough to look at (owner, 2026-08-23). Folder
// cards remap this range onto their own smaller curve.
export const ZOOM_MIN = 140
export const ZOOM_MAX = 640

/** A Justified row's target height, as a fraction of the shared zoom.
 *
 * Above 9/16 (a Card cover's height at the same zoom) because the layouts are
 * judged separately and Justified was the one reading as too small — it has no
 * title block under each tile, so the same height carries less weight on screen
 * (owner, 2026-08-23). Rows now actually reach this, which the packing rule
 * below did not previously manage. */
const JUSTIFIED_TARGET_FRACTION = 0.7

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

/** The shape the *justified* layout gives one tile.
 *
 * The cover's own dimensions first, because the cover is what the tile shows and
 * matching it is what keeps the cover out of black bars (owner, 2026-08-23).
 * `width`/`height` describe the file under the playback cursor, which is the
 * same file for a single-video bundle and a different one whenever a cover was
 * chosen or an image leads a video bundle — that mismatch was the black frame.
 * Falling back to them still beats guessing, and 16:9 is the last resort for a
 * bundle nothing has probed yet. */
function aspect(item: BundleSummary): number {
  if (item.cover_width && item.cover_height) return item.cover_width / item.cover_height
  if (item.width && item.height) return item.width / item.height
  return CARD_COVER_ASPECT
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
    const cardH = actualW / CARD_COVER_ASPECT + META_HEIGHT
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

  // Justified: each row is stretched to fill the width, so the only choice the
  // layout makes is where to break. It aims every row at `targetH`.
  const targetH = zoom * JUSTIFIED_TARGET_FRACTION
  const rows: Row[] = []
  let current: BundleSummary[] = []
  let aspectSum = 0

  /** The height a row of these items would take, stretched to the full width. */
  const heightFor = (sum: number, count: number): number =>
    (containerWidth - GAP * Math.max(0, count - 1)) / sum

  const flush = (isLast: boolean) => {
    if (current.length === 0) return
    let rowH = heightFor(aspectSum, current.length)
    // A short last row is not stretched — it simply stops short of the right
    // edge. Capped at the row above it rather than at the target, because a
    // library of one shape packs its full rows a little under the target and a
    // last row sitting *at* the target would still stand out. It used to be
    // allowed 1.3x the target, so the final row — a single bundle, often —
    // towered over everything above it (owner, 2026-08-23).
    if (isLast) {
      // `Row.height` carries the gap below it, so the row above's own height is
      // that minus the gap.
      const above = rows[rows.length - 1]
      rowH = Math.min(rowH, above ? above.height - GAP : Infinity, targetH)
    }
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
    const rowH = heightFor(aspectSum, current.length)
    if (rowH > targetH) continue // still room for more before the row is full

    // The row has just crossed the target. Breaking *before* this item leaves a
    // row taller than the target; breaking after leaves one shorter. Take
    // whichever is closer to it. The old rule always broke after, so every row
    // undershot — measured at 74-100% of the target, which is why the view read
    // as too small however far the slider was pushed (owner, 2026-08-23).
    const withoutH =
      current.length > 1 ? heightFor(aspectSum - aspect(item), current.length - 1) : Infinity
    if (Math.abs(withoutH - targetH) < Math.abs(rowH - targetH)) {
      current.pop()
      aspectSum -= aspect(item)
      flush(false)
      current.push(item)
      aspectSum += aspect(item)
    } else {
      flush(false)
    }
  }
  flush(true)
  return rows
}
