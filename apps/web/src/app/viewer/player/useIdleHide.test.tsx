import { act, renderHook } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { useIdleHide } from './useIdleHide'

function mount(pinned = false) {
  const root = document.createElement('div')
  document.body.append(root)
  const ref = createRef<HTMLElement>()
  ;(ref as { current: HTMLElement | null }).current = root
  const view = renderHook(() => useIdleHide(ref, pinned))
  return { root, view }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

test('the chrome hides once the pointer goes quiet', () => {
  const { view } = mount()
  expect(view.result.current).toBe(false)

  act(() => vi.advanceTimersByTime(3000))
  expect(view.result.current).toBe(true)
})

// A wheel is the owner working the controls just as much as a move is: zooming
// the range track let the chrome idle out from under the pointer mid-adjustment
// (owner-reported, 2026-08-30).
test.each([
  ['pointermove', () => new PointerEvent('pointermove', { bubbles: true })],
  ['pointerdown', () => new PointerEvent('pointerdown', { bubbles: true })],
  ['wheel', () => new WheelEvent('wheel', { bubbles: true, deltaY: -100 })],
])('%s wakes it again, and restarts the countdown', (_name, make) => {
  const { root, view } = mount()
  act(() => vi.advanceTimersByTime(3000))
  expect(view.result.current).toBe(true)

  act(() => {
    root.dispatchEvent(make())
  })
  expect(view.result.current).toBe(false)

  // Not just a one-off wake: the idle timer starts over.
  act(() => vi.advanceTimersByTime(2000))
  expect(view.result.current).toBe(false)
  act(() => vi.advanceTimersByTime(2000))
  expect(view.result.current).toBe(true)
})

// Pinned means a drag is in progress; the chrome must not go anywhere.
test('a pinned viewer never idles', () => {
  const { view } = mount(true)
  act(() => vi.advanceTimersByTime(10_000))
  expect(view.result.current).toBe(false)
})

// Hiding the chrome also makes it `pointer-events: none`, so a control hidden
// under the cursor swallows the next click into waking the chrome instead of
// pressing the button. The owner reported it as the first click on Save Moment
// doing nothing and the second one working (2026-08-30).
test('the chrome does not idle out from under a pointer resting on a control', () => {
  const { root, view } = mount()
  const controls = document.createElement('div')
  controls.className = 'mv-controls'
  root.append(controls)
  // jsdom has no hover state, so `:hover` never matches there. Stand in for the
  // browser's answer to "is the pointer on a control" at the one seam the hook
  // asks the question through.
  const real = root.querySelector.bind(root)
  vi.spyOn(root, 'querySelector').mockImplementation((selector: string) =>
    selector.includes(':hover') ? controls : real(selector),
  )

  act(() => vi.advanceTimersByTime(10_000))
  expect(view.result.current).toBe(false)
})

test('...and idles as usual once the pointer is no longer on one', () => {
  const { root, view } = mount()
  const controls = document.createElement('div')
  controls.className = 'mv-controls'
  root.append(controls)
  const real = root.querySelector.bind(root)
  // Hovering nothing: the countdown runs out as it always did.
  vi.spyOn(root, 'querySelector').mockImplementation((selector: string) =>
    selector.includes(':hover') ? null : real(selector),
  )

  act(() => vi.advanceTimersByTime(3000))
  expect(view.result.current).toBe(true)
})
