import { act, renderHook } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { BundleCardItem } from './BundleCard'
import { useQuickPreview } from './useQuickPreview'

const cards = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `b${index}` }) as BundleCardItem)

function setup(loaded: number, activeId: string, hasNextPage = true) {
  const onSelect = vi.fn()
  const fetchNextPage = vi.fn()
  const hook = renderHook(
    ({ items, active }) =>
      useQuickPreview({
        items,
        activeId: active,
        total: 8,
        hasNextPage,
        fetchingNextPage: false,
        fetchNextPage,
        onSelect,
      }),
    { initialProps: { items: cards(loaded), active: activeId } },
  )
  return { ...hook, onSelect, fetchNextPage }
}

test('the preview shows the active bundle only once opened, and steps within the result', () => {
  const { result, onSelect } = setup(8, 'b3', false)
  expect(result.current.item).toBeNull()
  act(() => result.current.show())
  expect(result.current.item?.id).toBe('b3')
  expect(result.current.position).toBe(3)
  act(() => result.current.step(1))
  expect(onSelect).toHaveBeenLastCalledWith('b4')
  // The harness keeps b3 active, so every step counts from it
  act(() => result.current.step(-3))
  expect(onSelect).toHaveBeenLastCalledWith('b0')
  onSelect.mockClear()
  act(() => result.current.step(-4))
  expect(onSelect).not.toHaveBeenCalled()
})

test('a step past the loaded bundles waits for the next page', () => {
  const { result, rerender, onSelect, fetchNextPage } = setup(5, 'b4')
  act(() => result.current.show())
  // Near the loaded edge the next page is already on its way
  expect(fetchNextPage).toHaveBeenCalled()
  act(() => result.current.step(1))
  expect(onSelect).not.toHaveBeenCalled()
  rerender({ items: cards(8), active: 'b4' })
  expect(onSelect).toHaveBeenCalledExactlyOnceWith('b5')
})
