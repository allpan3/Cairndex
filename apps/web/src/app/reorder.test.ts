import { describe, expect, it } from 'vitest'

import { gapBefore, moveManyTo, moveTo } from './reorder'

describe('moveTo', () => {
  it('inserts before and after the target slot', () => {
    expect(moveTo(['a', 'b', 'c'], 'c', 'a', true)).toEqual(['c', 'a', 'b'])
    expect(moveTo(['a', 'b', 'c'], 'a', 'c', false)).toEqual(['b', 'c', 'a'])
  })

  it('leaves the order alone when either id is unknown or they are the same', () => {
    expect(moveTo(['a', 'b'], 'a', 'a', true)).toEqual(['a', 'b'])
    expect(moveTo(['a', 'b'], 'z', 'a', true)).toEqual(['a', 'b'])
    expect(moveTo(['a', 'b'], 'a', 'z', true)).toEqual(['a', 'b'])
  })
})

describe('moveManyTo', () => {
  it('moves the dragged set as one block', () => {
    expect(moveManyTo(['a', 'b', 'c', 'd'], ['a', 'c'], 'd', false)).toEqual(['b', 'd', 'a', 'c'])
    expect(moveManyTo(['a', 'b', 'c', 'd'], ['b', 'd'], 'a', true)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('keeps the block in list order, not in the order it was selected', () => {
    expect(moveManyTo(['a', 'b', 'c', 'd'], ['d', 'b'], 'a', true)).toEqual(['b', 'd', 'a', 'c'])
  })

  it('places newcomers (dragged in from another group) at the slot', () => {
    // 'x' is appended by the caller when the drag came from another parent.
    expect(moveManyTo(['a', 'b', 'x'], ['x'], 'a', true)).toEqual(['x', 'a', 'b'])
  })

  it('is a no-op when the drop lands on a member of the dragged block', () => {
    expect(moveManyTo(['a', 'b', 'c'], ['a', 'b'], 'b', false)).toEqual(['a', 'b', 'c'])
  })

  it('ignores dragged ids that are not in the group', () => {
    expect(moveManyTo(['a', 'b', 'c'], ['a', 'zz'], 'c', false)).toEqual(['b', 'c', 'a'])
    expect(moveManyTo(['a', 'b'], ['zz'], 'a', true)).toEqual(['a', 'b'])
  })
})

describe('moveTo at the ends of a list', () => {
  // The reported bug: dragging the last item just past its neighbour swapped
  // the two instead of doing nothing. The move itself was always correct — the
  // caller passed the wrong side, having read a drop slot React had not yet
  // committed. These pin the semantics the caller has to preserve.
  it('is a no-op when an item is dropped back into its own gap', () => {
    expect(moveTo(['a', 'b', 'c'], 'c', 'b', false)).toEqual(['a', 'b', 'c'])
    expect(moveTo(['a', 'b', 'c'], 'a', 'b', true)).toEqual(['a', 'b', 'c'])
  })

  it('moves the last item ahead of its neighbour only when asked to', () => {
    expect(moveTo(['a', 'b', 'c'], 'c', 'b', true)).toEqual(['a', 'c', 'b'])
  })
})

describe('gapBefore', () => {
  it('names the row after the gap: leading edge is that row, trailing is the next', () => {
    expect(gapBefore(['a', 'b', 'c'], ['x'], 'b', 'before')).toBe('b')
    expect(gapBefore(['a', 'b', 'c'], ['x'], 'b', 'after')).toBe('c')
  })

  it('returns null past the end of the group (append)', () => {
    expect(gapBefore(['a', 'b', 'c'], ['x'], 'c', 'after')).toBeNull()
  })

  it('skips rows that are themselves moving', () => {
    // Dropping just past `b` while `c` is part of the block: the gap cannot be
    // named by `c`, which is leaving it — so it is the end of the group.
    expect(gapBefore(['a', 'b', 'c'], ['c'], 'b', 'after')).toBeNull()
    expect(gapBefore(['a', 'b', 'c', 'd'], ['c'], 'b', 'after')).toBe('d')
  })

  it('is null when the drop row is unknown', () => {
    expect(gapBefore(['a', 'b'], [], 'zz', 'before')).toBeNull()
  })
})
