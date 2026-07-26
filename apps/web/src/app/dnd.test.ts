import { describe, expect, it } from 'vitest'

import { dropZone, sameTreeDrop, seamFor } from './dnd'

const rect = (top: number, height: number, width = 226): DOMRect =>
  ({ left: 0, top, width, height, right: width, bottom: top + height }) as DOMRect

const zoneAt = (y: number, height: number) =>
  dropZone({ clientX: 0, clientY: y }, rect(0, height), 'vertical', true)

describe('dropZone edges on short rows', () => {
  it('gives a sidebar row a reorder edge you can actually hit', () => {
    // A 28px row at 28% would leave an 8px band — nesting won drags meant as
    // reorders. The floor is 10px at each end.
    expect(zoneAt(2, 28)).toBe('before')
    expect(zoneAt(9, 28)).toBe('before')
    expect(zoneAt(14, 28)).toBe('into')
    expect(zoneAt(19, 28)).toBe('after')
    expect(zoneAt(26, 28)).toBe('after')
  })

  it('still leaves a third of even a tiny row for nesting', () => {
    // 10px floor would swallow a 24px row whole, so the edges cap at a third.
    expect(zoneAt(12, 24)).toBe('into')
  })

  it('leaves tall cards on the proportional split', () => {
    const card = rect(0, 155)
    const at = (y: number) => dropZone({ clientX: 0, clientY: y }, card, 'vertical', true)
    expect(at(10)).toBe('before')
    expect(at(78)).toBe('into')
    expect(at(150)).toBe('after')
  })
})

describe('sameTreeDrop', () => {
  it('tells gaps in different groups apart', () => {
    expect(
      sameTreeDrop(
        { kind: 'gap', parentId: null, beforeId: null },
        { kind: 'gap', parentId: 'p', beforeId: null },
      ),
    ).toBe(false)
    expect(
      sameTreeDrop(
        { kind: 'gap', parentId: 'p', beforeId: 'x' },
        { kind: 'gap', parentId: 'p', beforeId: 'x' },
      ),
    ).toBe(true)
  })

  it('never confuses nesting with a gap', () => {
    expect(
      sameTreeDrop({ kind: 'into', id: 'x' }, { kind: 'gap', parentId: null, beforeId: 'x' }),
    ).toBe(false)
  })
})

describe('seamFor scoped to a tree group', () => {
  it('marks the end of a group on that group’s last row only', () => {
    const group = ['a', 'b']
    expect(group.map((id) => seamFor({ kind: 'gap', beforeId: null }, id, group))).toEqual([
      undefined,
      'after',
    ])
  })
})
