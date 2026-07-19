import { expect, test } from 'vitest'

import { isMultiSelection, selectionTargets } from './selection'

test('acts on just the clicked item when it is not part of a multi-selection', () => {
  expect(selectionTargets('a', new Set())).toEqual(['a'])
  expect(selectionTargets('a', new Set(['a']))).toEqual(['a'])
  // Clicking outside the current selection targets only the click.
  expect(selectionTargets('a', new Set(['b', 'c']))).toEqual(['a'])
})

test('acts on the whole selection when the clicked item is part of it', () => {
  expect(selectionTargets('a', new Set(['a', 'b'])).sort()).toEqual(['a', 'b'])
})

test('isMultiSelection is true only above one item', () => {
  expect(isMultiSelection(new Set())).toBe(false)
  expect(isMultiSelection(new Set(['a']))).toBe(false)
  expect(isMultiSelection(new Set(['a', 'b']))).toBe(true)
})
