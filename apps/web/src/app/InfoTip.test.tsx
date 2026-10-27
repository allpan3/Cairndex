import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { InfoTip } from './InfoTip'

// jsdom's window is 1024 × 768 and has no layout, so each test says where the
// button is and how big its text is
const rect = (left: number, top: number, width = 16, height = 16) =>
  ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

afterEach(() => vi.restoreAllMocks())

function renderTip(box: () => DOMRect, size = { width: 200, height: 80 }) {
  const view = render(
    <div data-testid="box">
      <InfoTip label="About this">A longer synthetic explanation.</InfoTip>
    </div>,
  )
  const button = screen.getByRole('button', { name: 'About this' })
  const tip = screen.getByRole('tooltip', { hidden: true })
  vi.spyOn(button, 'getBoundingClientRect').mockImplementation(box)
  Object.defineProperty(tip, 'offsetWidth', { configurable: true, value: size.width })
  Object.defineProperty(tip, 'offsetHeight', { configurable: true, value: size.height })
  return { ...view, button, tip }
}

test('focus shows the text below its button, outside any box that could clip it', () => {
  const { button, tip } = renderTip(() => rect(20, 40))
  expect(button).toHaveAttribute('aria-describedby', tip.id)
  expect(tip).toHaveTextContent('A longer synthetic explanation.')
  expect(tip).not.toBeVisible()

  fireEvent.focus(button)

  expect(tip).toBeVisible()
  expect(tip.parentElement).toBe(document.body)
  expect([tip.style.left, tip.style.top]).toEqual(['14px', '60px'])
  fireEvent.blur(button)
  expect(tip).not.toBeVisible()
})

test('near the bottom right of the window it opens upward, moved in from the edge', () => {
  const { button, tip } = renderTip(() => rect(1000, 730))
  fireEvent.focus(button)
  // Too little room below, so above (730 - 4 - 80), and left until it fits (1024 - 200 - 8)
  expect([tip.style.left, tip.style.top]).toEqual(['816px', '646px'])
})

test('text as wide as the window allows starts at its margin', () => {
  const { button, tip } = renderTip(() => rect(150, 40), { width: 1008, height: 120 })
  fireEvent.focus(button)
  expect(tip.style.left).toBe('8px')
})

test('the text hides while its button is out of sight, and follows it back', async () => {
  let box = rect(20, 150)
  const { button, tip } = renderTip(() => box)
  const scroller = screen.getByTestId('box')
  scroller.style.overflowY = 'auto'
  vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 400, 100))

  fireEvent.focus(button)
  // Scrolled below the box that clips it
  expect(tip).not.toBeVisible()

  box = rect(20, 40)
  await waitFor(() => expect(tip).toBeVisible())
  expect(tip.style.top).toBe('60px')

  // No box at all: a dialog over the list hid it
  box = rect(0, 0, 0, 0)
  await waitFor(() => expect(tip).not.toBeVisible())
})

test('a box around a fixed one, such as a dialog backdrop, does not hide the text', () => {
  const { button, tip } = renderTip(() => rect(20, 40))
  const fixed = screen.getByTestId('box')
  fixed.style.position = 'fixed'
  const around = fixed.parentElement!
  around.style.overflowY = 'hidden'
  vi.spyOn(around, 'getBoundingClientRect').mockReturnValue(rect(500, 500, 10, 10))

  fireEvent.focus(button)
  expect(tip).toBeVisible()
})

test('Escape hides it and stops there, until the pointer or focus brings it back', () => {
  const behind = vi.fn()
  window.addEventListener('keydown', behind)
  try {
    const { button, tip } = renderTip(() => rect(20, 40))
    fireEvent.focus(button)

    fireEvent.keyDown(button, { key: 'Escape' })
    expect(tip).not.toBeVisible()
    expect(behind).not.toHaveBeenCalled()

    // Hidden, it leaves Escape to the dialog behind it
    fireEvent.keyDown(button, { key: 'Escape' })
    expect(behind).toHaveBeenCalledTimes(1)

    fireEvent.mouseEnter(button)
    expect(tip).toBeVisible()
  } finally {
    window.removeEventListener('keydown', behind)
  }
})

test('the pointer can cross from the button onto the text without losing it', async () => {
  const { button, tip } = renderTip(() => rect(20, 40))
  fireEvent.mouseEnter(button)
  expect(tip).toBeVisible()

  fireEvent.mouseLeave(button)
  fireEvent.mouseEnter(tip)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(tip).toBeVisible()

  fireEvent.mouseLeave(tip)
  await waitFor(() => expect(tip).not.toBeVisible())
})

test('nothing is left on the page once it goes away', () => {
  const { button, unmount } = renderTip(() => rect(20, 40))
  fireEvent.focus(button)
  unmount()
  expect(document.querySelector('[role="tooltip"]')).toBeNull()
})
