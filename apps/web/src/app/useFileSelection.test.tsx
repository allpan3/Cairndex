import { act, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { linkedVideoEntry } from './testFixtures'
import { useFileSelection } from './useFileSelection'

const original = { ...linkedVideoEntry, file_id: 'a', relative_path: 'folder/a.mp4' }
const renamed = { ...original, relative_path: 'folder/renamed.mp4' }

test('selection and range focus follow the file identity through rename and reorder', () => {
  const { result, rerender } = renderHook(
    ({ entries }) => useFileSelection('rename', entries, true),
    { initialProps: { entries: [original] } },
  )
  act(() => {
    result.current.setSelected(new Set([original.relative_path]))
    result.current.setAnchor(original.relative_path)
    result.current.setFocusedPath(original.relative_path)
  })
  rerender({ entries: [{ ...original, file_id: 'b' }, renamed] })
  expect([...result.current.selected]).toEqual([renamed.relative_path])
  expect(result.current.anchor).toBe(renamed.relative_path)
  expect(result.current.focusedPath).toBe(renamed.relative_path)
})

test('partial or pending listings retain identity, while a complete missing result prunes it', () => {
  const { result, rerender } = renderHook(
    ({ entries, complete }) => useFileSelection('prune', entries, complete),
    { initialProps: { entries: [original], complete: true } },
  )
  act(() => result.current.setSelected(new Set([original.relative_path])))
  rerender({ entries: [], complete: false })
  rerender({ entries: [renamed], complete: true })
  expect([...result.current.selected]).toEqual([renamed.relative_path])
  rerender({ entries: [], complete: true })
  rerender({ entries: [renamed], complete: true })
  expect(result.current.selected.size).toBe(0)
})

test('navigation scopes isolate roots, views and servers while allowing a round-trip', () => {
  const { result, rerender } = renderHook(({ key }) => useFileSelection(key, [original], true), {
    initialProps: { key: 'server-a:library-a:folder' },
  })
  act(() => result.current.setSelected(new Set([original.relative_path])))
  for (const key of [
    'server-b:library-a:folder',
    'server-a:library-b:folder',
    'server-a:library-a:root',
    'server-a:library-a:unbundled',
  ]) {
    rerender({ key })
    expect(result.current.selected.size).toBe(0)
  }
  rerender({ key: 'server-a:library-a:folder' })
  expect([...result.current.selected]).toEqual([original.relative_path])
})
