import { describe, expect, it } from 'vitest'

import { rowStep, type NavTarget } from './spatialNav'

/** A grid of `perRow` tiles, 100×80 with a 10px gutter. */
function grid(count: number, perRow: number, offsetY = 0): NavTarget[] {
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / perRow)
    const column = index % perRow
    const top = offsetY + row * 90
    const left = column * 110
    return { id: `i${index}`, rect: { top, bottom: top + 80, left, right: left + 100 } }
  })
}

describe('rowStep', () => {
  it('moves down a row rather than one place along', () => {
    // The whole point: in a 3-wide grid, Down from the first tile is the fourth
    // item, not the second (owner, 2026-09-01).
    expect(rowStep(grid(9, 3), 'i0', 'down')).toBe('i3')
    expect(rowStep(grid(9, 3), 'i4', 'up')).toBe('i1')
  })

  it('keeps the column it is travelling in', () => {
    expect(rowStep(grid(9, 3), 'i2', 'down')).toBe('i5')
    expect(rowStep(grid(9, 3), 'i7', 'up')).toBe('i4')
  })

  it('lands on the nearest column when the next row is shorter', () => {
    const targets = grid(5, 3) // last row holds i3, i4 only
    expect(rowStep(targets, 'i2', 'down')).toBe('i4')
  })

  it('reports no row beyond the last and the first', () => {
    // Null, not a clamp: the caller falls back to its ordered neighbour, which
    // is what carries movement past a virtualized window's edge.
    expect(rowStep(grid(6, 3), 'i4', 'down')).toBeNull()
    expect(rowStep(grid(6, 3), 'i1', 'up')).toBeNull()
  })

  it('crosses from one section into the next', () => {
    // Folder cards above a bundle grid are one plane on screen, so Down out of
    // the folder row lands in the grid under it.
    const folders = grid(2, 2)
    const bundles = grid(4, 2, 200).map((target) => ({ ...target, id: `b${target.id}` }))
    const targets = [...folders, ...bundles]
    expect(rowStep(targets, 'i1', 'down')).toBe('bi1')
    expect(rowStep(targets, 'bi0', 'up')).toBe('i0')
  })

  it('treats full-width rows as one row each', () => {
    const rows: NavTarget[] = [0, 1, 2].map((index) => ({
      id: `r${index}`,
      rect: { top: index * 40, bottom: index * 40 + 38, left: 0, right: 900 },
    }))
    expect(rowStep(rows, 'r0', 'down')).toBe('r1')
    expect(rowStep(rows, 'r2', 'up')).toBe('r1')
  })

  it('tolerates a justified row of unequal heights', () => {
    const targets: NavTarget[] = [
      { id: 'a', rect: { top: 0, bottom: 90, left: 0, right: 160 } },
      { id: 'b', rect: { top: 5, bottom: 80, left: 170, right: 260 } },
      { id: 'c', rect: { top: 100, bottom: 180, left: 0, right: 120 } },
    ]
    expect(rowStep(targets, 'b', 'down')).toBe('c')
    expect(rowStep(targets, 'a', 'down')).toBe('c')
  })

  it('answers nothing when the current item is not rendered', () => {
    expect(rowStep(grid(4, 2), 'missing', 'down')).toBeNull()
    expect(rowStep([], null, 'down')).toBeNull()
  })

  it('answers nothing when nothing has been laid out', () => {
    // Every rect is empty in an unlaid-out document; the caller's ordered step
    // is the honest answer there, not a guess from zero geometry.
    const flat: NavTarget[] = ['a', 'b', 'c'].map((id) => ({
      id,
      rect: { top: 0, bottom: 0, left: 0, right: 0 },
    }))
    expect(rowStep(flat, 'a', 'down')).toBeNull()
  })
})
