import { describe, expect, it } from 'vitest'

import { moveManyTo, moveTo } from './reorder'

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
