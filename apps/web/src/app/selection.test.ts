import { expect, test, vi } from 'vitest'

import { dropRightClickSelection, isMultiSelection, selectionTargets } from './selection'

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

test('a right-click that opens a menu drops the word WebKit selected under it', () => {
  const removeAllRanges = vi.fn()
  vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    removeAllRanges,
  } as unknown as Selection)

  const row = document.createElement('div')
  row.className = 'card'
  dropRightClickSelection(row)

  expect(removeAllRanges).toHaveBeenCalledOnce()
  vi.restoreAllMocks()
})

test('a right-click inside a text field keeps its selection', () => {
  const removeAllRanges = vi.fn()
  vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    removeAllRanges,
  } as unknown as Selection)

  // The caret and any selection are the point in an editor — including an
  // inline rename box that sits inside a row with its own context menu.
  const row = document.createElement('div')
  const input = document.createElement('input')
  row.append(input)
  dropRightClickSelection(input)

  expect(removeAllRanges).not.toHaveBeenCalled()
  vi.restoreAllMocks()
})
