import { expect, test } from 'vitest'

import type { BundleSummary } from '../api/client'
import { CARD_COVER_ASPECT, ZOOM_MAX, ZOOM_MIN, computeRows } from './layout'

const META_HEIGHT = 44
const GAP = 10

/** A summary carrying only what the layout reads. */
function item(
  id: string,
  dims: { width?: number; height?: number; coverWidth?: number; coverHeight?: number } = {},
): BundleSummary {
  return {
    id,
    width: dims.width ?? null,
    height: dims.height ?? null,
    cover_width: dims.coverWidth ?? null,
    cover_height: dims.coverHeight ?? null,
  } as BundleSummary
}

test('a card tile gives its cover a 16:9 frame', () => {
  // 3 columns of 200 across 640 (2 gaps): 206.67 each.
  const rows = computeRows([item('a'), item('b'), item('c')], 'grid', 640, 200)

  expect(rows).toHaveLength(1)
  const width = rows[0]!.cards[0]!.width
  const coverHeight = rows[0]!.height - GAP - META_HEIGHT
  // Spelled out rather than compared against the constant, so moving the
  // constant fails here instead of quietly agreeing with itself. It was 0.62 of
  // the width — 1.61:1 — which put black bars on every 16:9 cover in the
  // library, which is nearly all of them.
  expect(CARD_COVER_ASPECT).toBeCloseTo(16 / 9, 10)
  expect(width / coverHeight).toBeCloseTo(16 / 9, 5)
})

test('the card frame is the same shape whatever the covers are', () => {
  const mixed = computeRows(
    [
      item('tall', { coverWidth: 1080, coverHeight: 1920 }),
      item('wide', { coverWidth: 3840, coverHeight: 1600 }),
    ],
    'grid',
    640,
    200,
  )

  // One shape for all of them is the whole point of the layout; a cover that is
  // not 16:9 letterboxes inside its frame rather than reshaping it.
  const widths = mixed.flatMap((row) => row.cards.map((card) => card.width))
  expect(new Set(widths).size).toBe(1)
})

test('a justified tile takes the shape of its own cover', () => {
  // A 4:3 cover on a bundle whose cursor file is 16:9 — a chosen cover, or an
  // image leading a video bundle. The tile used to follow the cursor file, so
  // the cover sat in black bars (owner, 2026-08-23).
  const rows = computeRows(
    [item('a', { width: 1920, height: 1080, coverWidth: 1024, coverHeight: 768 })],
    'justified',
    900,
    200,
  )

  const card = rows[0]!.cards[0]!
  const height = rows[0]!.height - GAP
  expect(card.width / height).toBeCloseTo(4 / 3, 5)
})

test('a justified tile falls back to the cursor file, then to 16:9', () => {
  const shapeOf = (summary: BundleSummary): number => {
    const row = computeRows([summary], 'justified', 900, 200)[0]
    if (!row) throw new Error('expected a row')
    return row.cards[0]!.width / (row.height - GAP)
  }

  // No cover dimensions: the cursor file is the next best description of what
  // the tile will show, since for a single-file bundle it *is* the cover.
  expect(shapeOf(item('cursor', { width: 1000, height: 500 }))).toBeCloseTo(2, 5)
  // Nothing probed at all — a guess either way, so guess the library's shape.
  expect(shapeOf(item('unprobed'))).toBeCloseTo(CARD_COVER_ASPECT, 5)
})

test('the zoom range reaches a card worth looking at, and none too small to read', () => {
  // Shifted up twice from 80–360 (owner, 2026-08-23). Pinned because three
  // curves — list row height, folder card width, justified row height — are all
  // derived from these bounds, so moving them is never a one-line change.
  expect(ZOOM_MIN).toBe(140)
  expect(ZOOM_MAX).toBe(640)

  const biggest = computeRows([item('a')], 'grid', ZOOM_MAX + 100, ZOOM_MAX)
  expect(biggest[0]!.cards[0]!.width).toBeGreaterThanOrEqual(ZOOM_MAX)
})

/** Every justified row's height, in source order. */
function justifiedHeights(items: BundleSummary[], containerWidth: number, zoom: number): number[] {
  return computeRows(items, 'justified', containerWidth, zoom).map((row) => row.height - GAP)
}

/** Covers in four shapes, the mix a real library has. */
const SHAPES = [
  { coverWidth: 1920, coverHeight: 1080 },
  { coverWidth: 1080, coverHeight: 1920 },
  { coverWidth: 1024, coverHeight: 768 },
  { coverWidth: 3840, coverHeight: 1600 },
]

test('justified rows land on the target height instead of undershooting it', () => {
  // Twenty mixed covers in a 900px pane at zoom 200 → a 140px target.
  const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, SHAPES[i % SHAPES.length]))
  const target = 200 * 0.7

  const heights = justifiedHeights(items, 900, 200)

  // The old rule always broke *after* the item that crossed the target, so a
  // wide cover landing at the end of a row dragged the whole row down: the same
  // fixture came out at 101–130px against a 140px target, every row under it,
  // the worst 27% under. That is why the view read as too small however far the
  // slider was pushed (owner, 2026-08-23). Now: within 10%.
  for (const height of heights) {
    expect(Math.abs(height - target) / target).toBeLessThan(0.1)
  }
  // At least one full row sits *above* the target, which breaking-after could
  // never produce.
  expect(heights.slice(0, -1).some((height) => height > target)).toBe(true)
})

test('a short last row is never taller than the row above it', () => {
  // Five 16:9 covers in a 900px pane pack four to a row, leaving one alone on
  // the last row — the case the owner saw, where that lone bundle came out huge.
  const items = Array.from({ length: 5 }, (_, i) =>
    item(`i${i}`, { coverWidth: 1920, coverHeight: 1080 }),
  )

  const heights = justifiedHeights(items, 900, 200)

  expect(heights).toHaveLength(2)
  // Stretched, one 16:9 tile across 900px would be 506px tall; the old cap of
  // 1.3x the target still left it at 182 against a 122px row above it.
  expect(heights[1]).toBeCloseTo(heights[0]!, 5)
})

test('a lone last tile keeps its shape rather than filling the row', () => {
  const rows = computeRows(
    Array.from({ length: 5 }, (_, i) => item(`i${i}`, { coverWidth: 1920, coverHeight: 1080 })),
    'justified',
    900,
    200,
  )
  const lastRow = rows[rows.length - 1]!

  expect(lastRow.cards).toHaveLength(1)
  // It stops short of the right edge, which is what a justified gallery does
  // with a row it cannot fill.
  const height = lastRow.height - GAP
  expect(lastRow.cards[0]!.width).toBeCloseTo((height * 16) / 9, 5)
  expect(lastRow.cards[0]!.width).toBeLessThan(900)
})
