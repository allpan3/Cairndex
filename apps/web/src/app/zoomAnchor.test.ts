import { expect, test } from 'vitest'

import type { BundleSummary } from '../api/client'
import { computeRows } from './layout'
import { cardCentre, zoomAnchor } from './zoomAnchor'

const items = Array.from({ length: 30 }, (_, index) => ({ id: `b${index}` }) as BundleSummary)

function tops(rows: { height: number }[]): number[] {
  let at = 0
  return rows.map((row) => {
    const top = at
    at += row.height
    return top
  })
}

test('a zoom holds the active item while it is in view', () => {
  const rows = computeRows(items, 'grid', 650, 200)
  const rowTops = tops(rows)
  const view = { top: 0, bottom: 400, width: 650 }
  expect(zoomAnchor(rows, rowTops, view, 'b4')).toBe('b4')
})

test('an active item out of view gives way to the item nearest the middle', () => {
  const rows = computeRows(items, 'grid', 650, 200)
  const rowTops = tops(rows)
  // Three 210-wide columns: rows of three, so b0–b2 fill the first row
  const second = rowTops[1]!
  const view = { top: second, bottom: second + rows[1]!.height, width: 650 }
  expect(zoomAnchor(rows, rowTops, view, 'b29')).toBe('b4')
})

test('the centre follows the item into another layout', () => {
  const small = computeRows(items, 'grid', 650, 200)
  const large = computeRows(items, 'grid', 650, 320)
  const before = cardCentre(small, tops(small), 'b7')!
  const after = cardCentre(large, tops(large), 'b7')!
  // b7 moves from the third row's middle column to the fourth row's second
  expect(after.y).toBeGreaterThan(before.y)
  expect(cardCentre(large, tops(large), 'missing')).toBeNull()
})
