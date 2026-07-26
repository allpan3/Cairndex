import { act, render } from '@testing-library/react'
import { createElement, useRef } from 'react'
import { describe, expect, it } from 'vitest'

import { useMarqueeSelect } from './useMarqueeSelect'

/** Mounts the hook over a scrollable box, and returns the surface a gesture
 *  starts from plus the recorded onChange calls. */
function mount(rubberBand: boolean) {
  const changes: string[][] = []
  function Harness() {
    const ref = useRef<HTMLDivElement | null>(null)
    const { marqueeRect, onMouseDown } = useMarqueeSelect({
      getScrollEl: () => ref.current,
      getWrapperEl: () => ref.current,
      isBackgroundTarget: () => true,
      hitTest: () => ['a', 'b'],
      getBaseSelection: () => new Set<string>(),
      onChange: (ids) => changes.push(ids),
      rubberBand,
    })
    return createElement('div', {
      ref,
      'data-testid': 'surface',
      'data-band': marqueeRect ? 'yes' : 'no',
      onMouseDown,
    })
  }
  const view = render(createElement(Harness))
  return { surface: view.getByTestId('surface'), changes }
}

const press = (el: HTMLElement) =>
  el.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 5, clientY: 5 }),
  )
const moveFar = () =>
  window.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 80, clientY: 90 }))
const release = () => window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))

describe('useMarqueeSelect with the rubber band switched off', () => {
  it('draws no band and selects nothing on a drag', () => {
    // The list layouts: a band down one column of rows can only pick a
    // consecutive run, which Shift-click already does, so the rows keep their
    // drag instead.
    const { surface, changes } = mount(false)
    act(() => {
      press(surface)
      moveFar()
    })
    expect(surface.dataset.band).toBe('no')
    expect(changes).toEqual([])
    act(release)
  })

  it('still clears the selection on a plain click', () => {
    const { surface, changes } = mount(false)
    act(() => {
      press(surface)
      release()
    })
    expect(changes).toEqual([[]])
  })
})

describe('useMarqueeSelect with the rubber band on', () => {
  it('bands out a selection as the pointer moves', () => {
    const { surface, changes } = mount(true)
    act(() => {
      press(surface)
      moveFar()
    })
    expect(surface.dataset.band).toBe('yes')
    expect(changes.at(-1)).toEqual(['a', 'b'])
    act(release)
  })

  it('clears the selection on a plain click, same as with it off', () => {
    const { surface, changes } = mount(true)
    act(() => {
      press(surface)
      release()
    })
    expect(changes).toEqual([[]])
  })
})
