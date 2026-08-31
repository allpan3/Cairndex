import { act, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'

import { ContextMenu } from './ContextMenu'
import type { MenuEntry, MenuState } from './useContextMenu'
import { useContextMenu } from './useContextMenu'

function renderMenu(items: MenuEntry[], onClose = vi.fn()) {
  render(<ContextMenu state={{ x: 10, y: 10, items }} onClose={onClose} />)
  return onClose
}

test('renders enabled items and separators', () => {
  renderMenu([
    { label: 'Open', onClick: vi.fn() },
    null,
    { label: 'Delete', onClick: vi.fn(), danger: true },
  ])
  expect(screen.getByRole('menuitem', { name: 'Open' })).toBeInTheDocument()
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('context-menu__item--danger')
  expect(screen.getByRole('separator')).toBeInTheDocument()
})

test('clicking an item fires its handler and closes the menu', () => {
  const onClick = vi.fn()
  const onClose = renderMenu([{ label: 'Delete', onClick }])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
  expect(onClick).toHaveBeenCalledOnce()
  expect(onClose).toHaveBeenCalledOnce()
})

test('a disabled item does not fire its handler', () => {
  const onClick = vi.fn()
  renderMenu([{ label: 'Open', onClick, disabled: true }])
  const item = screen.getByRole('menuitem', { name: 'Open' })
  expect(item).toBeDisabled()
  fireEvent.click(item)
  expect(onClick).not.toHaveBeenCalled()
})

test('Escape and outside clicks close the menu', () => {
  const onClose = renderMenu([{ label: 'Open', onClick: vi.fn() }])
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).toHaveBeenCalled()

  onClose.mockClear()
  fireEvent.mouseDown(document.body)
  expect(onClose).toHaveBeenCalled()
})

test('renders nothing when state is null', () => {
  const { container } = render(<ContextMenu state={null} onClose={vi.fn()} />)
  expect(container).toBeEmptyDOMElement()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

test('the gesture that dismisses the menu does not reach what is underneath', () => {
  // The viewer's own report: right-click the video, left-click to dismiss, and
  // the dismissing click also toggled playback (owner, 2026-08-23). `onClose`
  // clears the state that keeps this component's listeners mounted, so the
  // `click` still to come could arrive after they were gone — engine-dependent,
  // which is why Chromium behaved and WKWebView did not.
  const underneath = vi.fn()
  document.body.addEventListener('click', underneath)
  document.body.addEventListener('mouseup', underneath)
  try {
    renderMenu([{ label: 'Play', onClick: vi.fn() }])

    // The whole gesture, in the order an engine dispatches it.
    fireEvent.mouseDown(document.body)
    fireEvent.mouseUp(document.body)
    fireEvent.click(document.body)

    expect(underneath).not.toHaveBeenCalled()
  } finally {
    document.body.removeEventListener('click', underneath)
    document.body.removeEventListener('mouseup', underneath)
  }
})

test('a later click, after the gesture is over, is left alone', async () => {
  // The swallow is one-shot: it must not go on eating clicks, which is how the
  // ref it replaces used to make the *next* click do nothing. Driven through a
  // real state transition, because a menu that never closes keeps its own
  // listeners and would pass this for the wrong reason.
  const underneath = vi.fn()
  document.body.addEventListener('click', underneath)
  try {
    function Host() {
      const [state, setState] = useState<MenuState | null>({
        x: 10,
        y: 10,
        items: [{ label: 'Play', onClick: vi.fn() }],
      })
      return <ContextMenu state={state} onClose={() => setState(null)} />
    }
    render(<Host />)

    fireEvent.mouseDown(document.body)
    fireEvent.click(document.body)
    expect(underneath).not.toHaveBeenCalled()

    // Let the one-shot teardown run, the same macrotask the component uses.
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(document.body)

    expect(underneath).toHaveBeenCalledTimes(1)
  } finally {
    document.body.removeEventListener('click', underneath)
  }
})

test('opening a menu drops the text selection the right-click made', () => {
  const removeAllRanges = vi.fn()
  vi.spyOn(globalThis, 'getSelection').mockReturnValue({
    removeAllRanges,
  } as unknown as Selection)

  // The wiring, not the helper: every surface in the app opens its menu through
  // this hook, which is why one call here covers all of them.
  function Surface() {
    const menu = useContextMenu()
    return (
      <>
        <div onContextMenu={(e) => menu.open(e, [{ label: 'Delete', onClick: vi.fn() }])}>
          a title with words in it
        </div>
        <ContextMenu state={menu.state} onClose={menu.close} />
      </>
    )
  }
  render(<Surface />)

  fireEvent.contextMenu(screen.getByText('a title with words in it'))

  expect(removeAllRanges).toHaveBeenCalledOnce()
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()
  vi.restoreAllMocks()
})

// The gesture that opens a menu is allowed to scroll. Clicking a `⋯` button near
// the edge of a scrollable rail focuses it, and the browser brings it into view
// in the same dispatch — so a menu that dismissed on the very next scroll event
// dismissed itself (found by the moments e2e, 2026-08-29).
test('a scroll from the opening gesture does not dismiss the menu', () => {
  function Surface() {
    const menu = useContextMenu()
    return (
      <>
        <button onClick={(e) => menu.open(e, [{ label: 'Delete', onClick: vi.fn() }])}>more</button>
        <ContextMenu state={menu.state} onClose={menu.close} />
      </>
    )
  }
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    frames.push(fn)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  render(<Surface />)

  fireEvent.click(screen.getByRole('button', { name: 'more' }))
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()

  // Same dispatch, before the next frame: part of opening, not a later movement.
  fireEvent.scroll(window, {})
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()

  // From the next frame on, a scroll means the anchor has moved under it.
  act(() => frames.splice(0, frames.length).forEach((fn) => fn(0)))
  fireEvent.scroll(window, {})
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()

  vi.unstubAllGlobals()
})

/** A card-like surface: a menu on right-click, "open" on double-click. */
function OpenableSurface({ onOpen }: { onOpen: () => void }) {
  const menu = useContextMenu()
  return (
    <>
      <div
        data-testid="card"
        onContextMenu={(e) => menu.open(e, [{ label: 'Delete', onClick: vi.fn() }])}
        onDoubleClick={onOpen}
      >
        a bundle
      </div>
      <ContextMenu state={menu.state} onClose={menu.close} />
    </>
  )
}

/** Fire one press-release-click at `detail`, as the browser numbers a pair. */
function press(target: Element, detail: number) {
  const opts = { bubbles: true, cancelable: true, detail }
  fireEvent(target, new MouseEvent('mousedown', { ...opts, buttons: 1 }))
  fireEvent(target, new MouseEvent('mouseup', opts))
  fireEvent(target, new MouseEvent('click', opts))
}

// Swallowing the dismissing click hides it from the app but not from the
// browser's click counter, so the *next* press arrives as click two of a pair and
// delivers `dblclick` — which on a bundle card opens the media viewer. To the
// owner that is one click opening the player (owner-reported, 2026-08-29).
test('the press after dismissing a menu does not complete a double-click', () => {
  const onOpen = vi.fn()
  render(<OpenableSurface onOpen={onOpen} />)
  const card = screen.getByTestId('card')

  fireEvent.contextMenu(card)
  expect(screen.getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument()

  press(card, 1) // dismisses the menu; the app never sees this click
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()

  press(card, 2) // the owner's next click — the browser calls it click two
  fireEvent.dblClick(card, { detail: 2 })

  expect(onOpen).not.toHaveBeenCalled()
})

test('a genuine double-click still opens', () => {
  const onOpen = vi.fn()
  render(<OpenableSurface onOpen={onOpen} />)
  const card = screen.getByTestId('card')

  press(card, 1)
  press(card, 2)
  fireEvent.dblClick(card, { detail: 2 })

  expect(onOpen).toHaveBeenCalledOnce()
})

// The guard covers the pair the dismissal started and nothing after it: a later,
// unrelated double-click must still open.
test('a double-click after an intervening click still opens', () => {
  const onOpen = vi.fn()
  render(<OpenableSurface onOpen={onOpen} />)
  const card = screen.getByTestId('card')

  fireEvent.contextMenu(card)
  press(card, 1) // dismiss
  press(card, 1) // a fresh, separate click — the pair window has closed
  press(card, 1)
  press(card, 2)
  fireEvent.dblClick(card, { detail: 2 })

  expect(onOpen).toHaveBeenCalledOnce()
})
