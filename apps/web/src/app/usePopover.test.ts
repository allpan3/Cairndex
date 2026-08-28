import { expect, test } from 'vitest'

import { flattenHierarchy, visibleHierarchy } from './usePopover'

/**
 * The two tree walks behind every hierarchy picker in the app — the bundle
 * inspector's collections, the tag filter, and New Collection from Folder's
 * parent field. They had no tests until three callers depended on them
 * (2026-08-28), which is also when `CollectionPicker`'s own near-identical copy
 * was folded into `visibleHierarchy`.
 */
interface Item {
  id: string
  name: string
  parent_id: string | null
}

const item = (id: string, name: string, parent_id: string | null = null): Item => ({
  id,
  name,
  parent_id,
})

/** Rows as `id@depth` (with `+` for a row that has children), for compact asserts. */
const shape = (rows: { item: Item; depth: number; hasChildren?: boolean }[]) =>
  rows.map((r) => `${r.item.id}@${r.depth}${r.hasChildren ? '+' : ''}`)

test('a tree walks depth-first, alphabetically within each level', () => {
  const items = [
    item('shows', 'Shows'),
    item('archive', 'Archive'),
    item('year', 'By Year', 'archive'),
    item('y24', '2024', 'year'),
  ]

  expect(shape(visibleHierarchy(items, new Set()))).toEqual([
    'archive@0+',
    'year@1+',
    'y24@2',
    'shows@0',
  ])
})

test('a collapsed row keeps its own place and hides everything beneath it', () => {
  const items = [
    item('archive', 'Archive'),
    item('year', 'By Year', 'archive'),
    item('y24', '2024', 'year'),
    item('shows', 'Shows'),
  ]

  expect(shape(visibleHierarchy(items, new Set(['year'])))).toEqual([
    'archive@0+',
    'year@1+',
    'shows@0',
  ])
  // Collapsing the root hides the whole branch but not its sibling.
  expect(shape(visibleHierarchy(items, new Set(['archive'])))).toEqual(['archive@0+', 'shows@0'])
})

test('an orphan is shown at the top level rather than dropped', () => {
  // A filtered subset can omit a parent while keeping its child. Re-parenting
  // renders the subset as a sensible forest; dropping the row would hide a
  // result the caller had deliberately kept.
  const items = [item('child', 'Child', 'absent'), item('top', 'Top')]

  expect(shape(visibleHierarchy(items, new Set()))).toEqual(['child@0', 'top@0'])
})

test('a cycle does not hang the walk', () => {
  // Two rows each claiming the other as parent are unreachable from the root, so
  // the walk simply yields nothing rather than recursing forever.
  const items = [item('a', 'A', 'b'), item('b', 'B', 'a')]

  expect(visibleHierarchy(items, new Set())).toEqual([])
})

test('flatten keeps depth but never hides anything', () => {
  const items = [item('archive', 'Archive'), item('year', 'By Year', 'archive')]

  expect(shape(flattenHierarchy(items))).toEqual(['archive@0', 'year@1'])
})
