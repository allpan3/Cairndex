import { beforeEach, expect, test, vi } from 'vitest'

import { catalog, runJob } from './catalog'
import {
  moveBundlesToCollection,
  moveCollections,
  sortCollectionsByName,
  type ForestItem,
} from './catalogOrganize'

vi.mock('./catalog', () => ({
  catalog: vi.fn(),
  runJob: vi.fn(),
  operationId: () => 'synthetic-operation',
}))

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

// One membership choice per target, as the selection read returns it
function choices(assigned: Record<string, number>, held = false) {
  vi.mocked(catalog).mockImplementation(async (_library, _path, _method, body) => {
    const target = (body as { target: string }).target
    return {
      items: [{ id: target, name: target, assigned_count: assigned[target], observed: {}, held }],
      next_cursor: null,
    } as never
  })
}

beforeEach(() => {
  vi.mocked(catalog).mockReset()
  vi.mocked(runJob).mockReset()
  vi.mocked(runJob).mockResolvedValue({ id: 'job', receipt: 'receipt' } as never)
})

const bulk = () =>
  vi
    .mocked(runJob)
    .mock.calls.filter(([, action]) => action === 'preview')
    .map(([, , command]) => command as { target: string; assigned: boolean })

test('a move adds to the target and then removes from the source', async () => {
  choices({ target: 0, source: 2 })
  await moveBundlesToCollection('library', ['one', 'two'], 'target', 'source')
  expect(bulk().map(({ target, assigned }) => [target, assigned])).toEqual([
    ['target', true],
    ['source', false],
  ])
})

test('a copy or an already complete side commits nothing for that side', async () => {
  choices({ target: 2, source: 0 })
  await moveBundlesToCollection('library', ['one', 'two'], 'target', 'source')
  await moveBundlesToCollection('library', ['one', 'two'], 'target', null)
  expect(bulk()).toEqual([])
})

test('a held choice or an oversized selection is refused before any write', async () => {
  choices({ target: 0 }, true)
  await expect(moveBundlesToCollection('library', ['one'], 'target', null)).rejects.toThrow(
    'metadata review',
  )
  const many = Array.from({ length: 101 }, (_, index) => `bundle-${index}`)
  await expect(moveBundlesToCollection('library', many, 'target', null)).rejects.toThrow(
    'at most 100',
  )
  expect(runJob).not.toHaveBeenCalled()
})
