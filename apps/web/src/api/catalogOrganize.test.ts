import { expect, test } from 'vitest'

import { moveCollections, sortCollectionsByName, type ForestItem } from './catalogOrganize'

const names = { a: 'Alpha', b: 'Beta', c: 'Gamma', d: 'Delta', e: 'Echo' }

// Two roots (a, b) with three children of a; c and d share a sort order
const forest: ForestItem[] = [
  { id: 'a', parent_id: null, sort_order: 0 },
  { id: 'b', parent_id: null, sort_order: 1 },
  { id: 'c', parent_id: 'a', sort_order: 5 },
  { id: 'd', parent_id: 'a', sort_order: 5 },
  { id: 'e', parent_id: 'a', sort_order: 9 },
]

function order(items: ForestItem[], parent: string | null): string[] {
  return items
    .filter((item) => item.parent_id === parent)
    .sort((x, y) => x.sort_order - y.sort_order)
    .map((item) => item.id)
}

test('a move renumbers only the target group, in the order the sidebar shows', () => {
  const moved = moveCollections(forest, names, ['e'], 'a', 'c')
  // Ties draw by name, so Delta comes before Gamma
  expect(order(moved, 'a')).toEqual(['d', 'e', 'c'])
  expect(moved.find((item) => item.id === 'b')).toEqual(forest[1])
})

test('a reparent keeps the movers in their shown order and appends without a target', () => {
  const moved = moveCollections(forest, names, ['c', 'd'], null, null)
  expect(order(moved, null)).toEqual(['a', 'b', 'd', 'c'])
  expect(order(moved, 'a')).toEqual(['e'])
  // The source group keeps its values; its gap is harmless
  expect(moved.find((item) => item.id === 'e')?.sort_order).toBe(9)
})

test('a missing target appends', () => {
  expect(order(moveCollections(forest, names, ['b'], 'a', 'gone'), 'a')).toEqual([
    'd',
    'c',
    'e',
    'b',
  ])
})

test('name cleanup orders every group in either direction', () => {
  const ascending = sortCollectionsByName(forest, names, 'asc')
  expect(order(ascending, null)).toEqual(['a', 'b'])
  expect(order(ascending, 'a')).toEqual(['d', 'e', 'c'])
  const descending = sortCollectionsByName(forest, names, 'desc')
  expect(order(descending, null)).toEqual(['b', 'a'])
  expect(order(descending, 'a')).toEqual(['c', 'e', 'd'])
  expect(descending.map((item) => item.id)).toEqual(forest.map((item) => item.id))
})
