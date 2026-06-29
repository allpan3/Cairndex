import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { ContextMenu } from './ContextMenu'
import type { MenuEntry } from './useContextMenu'

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
