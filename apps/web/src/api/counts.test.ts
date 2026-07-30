import { expect, test } from 'vitest'

import type { CollectionRead } from './client'
import {
  applyCountDeltas,
  collectionCountDeltas,
  countingCollectionIds,
  emptyMembershipDelta,
  nextMembership,
  tagCountDeltas,
} from './counts'

function collection(id: string, parentId: string | null = null): CollectionRead {
  return {
    id,
    parent_id: parentId,
    name: id,
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  }
}

//   root ── child ── grandchild
//   sibling
//   orphan (no relation to either)
const TREE = [
  collection('root'),
  collection('child', 'root'),
  collection('grandchild', 'child'),
  collection('sibling'),
  collection('orphan'),
]

const deltas = (before: string[], after: string[]) =>
  Object.fromEntries(collectionCountDeltas(TREE, [{ before, after }]))

test('a membership counts toward the collection itself and every ancestor', () => {
  expect([...countingCollectionIds(TREE, ['grandchild'])].sort()).toEqual([
    'child',
    'grandchild',
    'root',
  ])
})

test('an id the client has not loaded still counts itself', () => {
  expect([...countingCollectionIds(TREE, ['unknown'])]).toEqual(['unknown'])
})

test('sibling to sibling moves both counts and nothing else', () => {
  expect(deltas(['sibling'], ['orphan'])).toEqual({ sibling: -1, orphan: 1 })
})

test('parent to its own child leaves the shared ancestors alone', () => {
  // The whole reason a flat ±1 was wrong: `root` still counts this bundle.
  expect(deltas(['root'], ['grandchild'])).toEqual({ grandchild: 1, child: 1 })
})

test('child to its own parent likewise only drops the descendants', () => {
  expect(deltas(['grandchild'], ['root'])).toEqual({ grandchild: -1, child: -1 })
})

test('adding a collection the bundle is already in changes nothing', () => {
  expect(deltas(['sibling'], ['sibling'])).toEqual({})
})

test('a second membership under the same ancestor does not count it twice', () => {
  // Already in `grandchild`, now also in `child`: `root` and `child` were
  // already counting this bundle, so only nothing moves.
  expect(deltas(['grandchild'], ['grandchild', 'child'])).toEqual({})
  // …and leaving one of the two leaves the ancestors where they were.
  expect(deltas(['grandchild', 'child'], ['child'])).toEqual({ grandchild: -1 })
})

test('a multi-select batch sums its bundles', () => {
  const summed = collectionCountDeltas(TREE, [
    { before: ['sibling'], after: ['orphan'] },
    { before: ['sibling'], after: ['orphan'] },
    { before: ['root'], after: ['orphan'] },
  ])
  expect(Object.fromEntries(summed)).toEqual({ sibling: -2, root: -1, orphan: 3 })
})

test('a copy (nothing removed) only adds', () => {
  expect(deltas(['sibling'], ['sibling', 'orphan'])).toEqual({ orphan: 1 })
})

test('Uncategorized moves only when the last membership goes or the first arrives', () => {
  expect(emptyMembershipDelta([{ before: [], after: ['sibling'] }])).toBe(-1)
  expect(emptyMembershipDelta([{ before: ['sibling'], after: [] }])).toBe(1)
  expect(emptyMembershipDelta([{ before: ['sibling'], after: ['orphan'] }])).toBe(0)
  expect(
    emptyMembershipDelta([
      { before: [], after: ['sibling'] },
      { before: [], after: ['orphan'] },
    ]),
  ).toBe(-2)
})

test('tag counts are direct membership, so no ancestor arithmetic', () => {
  expect(Object.fromEntries(tagCountDeltas([{ before: ['a'], after: ['b', 'c'] }]))).toEqual({
    a: -1,
    b: 1,
    c: 1,
  })
})

test('applying deltas leaves untouched collections alone and never goes negative', () => {
  const counts = { sibling: 2, orphan: 0, root: 7 }
  expect(applyCountDeltas(counts, new Map([['sibling', -1]]))).toEqual({
    sibling: 1,
    orphan: 0,
    root: 7,
  })
  // A count that disagrees with the cache (another client wrote in between)
  // must not render as a negative number while the refetch lands.
  expect(applyCountDeltas(counts, new Map([['orphan', -3]])).orphan).toBe(0)
  // A collection with no cached count yet still lands on a sane number.
  expect(applyCountDeltas(counts, new Map([['fresh', 1]])).fresh).toBe(1)
})

test('the resulting membership applies removals before adds, as the server does', () => {
  expect(nextMembership(['a', 'b'], ['c'], ['a'])).toEqual(['b', 'c'])
  // An id in both lists ends up present.
  expect(nextMembership(['a'], ['a'], ['a'])).toEqual(['a'])
  // Re-adding an existing membership does not duplicate it.
  expect(nextMembership(['a'], ['a'], [])).toEqual(['a'])
})
