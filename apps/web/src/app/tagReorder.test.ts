import { describe, expect, it } from 'vitest'

import { moveWithin, planReorder } from './tagReorder'

// A minimal target for the pure planner (only tag.id + parentKey are read).
const row = (id: string, parentKey: string | null) => ({ tag: { id }, parentKey })

describe('moveWithin', () => {
  it('inserts after the target when dragging down', () => {
    expect(moveWithin(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a'])
  })
  it('inserts before the target when dragging up', () => {
    expect(moveWithin(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  })
  it('is a no-op dropping on itself', () => {
    expect(moveWithin(['a', 'b'], 'a', 'a')).toEqual(['a', 'b'])
  })
})

describe('planReorder', () => {
  // Hierarchy: p → c (child of p); leaf (root). parents map + membership set.
  const parents: Record<string, string | null> = { p: null, c: 'p', leaf: null }
  const parentOf = (id: string) => parents[id] ?? null
  const hasTag = (id: string) => id in parents

  it('reorders root-level siblings', () => {
    const plan = planReorder({
      dragId: 'leaf',
      target: row('p', null),
      groupId: null,
      parentOf,
      hasTag,
      siblingIds: ['p', 'leaf'],
      groupOrder: [],
    })
    expect(plan).toEqual({ kind: 'siblings', parentId: null, orderedIds: ['leaf', 'p'] })
  })

  it('refuses to move a child out of its parent (no reparenting)', () => {
    // Dragging the child (under p) onto the root-level leaf: different sibling
    // groups → no plan.
    const plan = planReorder({
      dragId: 'c',
      target: row('leaf', null),
      groupId: null,
      parentOf,
      hasTag,
      siblingIds: ['p', 'leaf'],
      groupOrder: [],
    })
    expect(plan).toBeNull()
  })

  it('reorders within a group (membership order) without touching hierarchy', () => {
    const plan = planReorder({
      dragId: 'a',
      target: row('b', 'group:g1'),
      groupId: 'g1',
      parentOf,
      hasTag,
      siblingIds: [],
      groupOrder: ['a', 'b'],
    })
    expect(plan).toEqual({ kind: 'group', groupId: 'g1', orderedIds: ['b', 'a'] })
  })

  it('is a no-op dropping on itself', () => {
    const plan = planReorder({
      dragId: 'p',
      target: row('p', null),
      groupId: null,
      parentOf,
      hasTag,
      siblingIds: ['p', 'leaf'],
      groupOrder: [],
    })
    expect(plan).toBeNull()
  })
})
