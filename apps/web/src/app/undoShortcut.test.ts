import { renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { undoStamp, useUndoShortcut, type Undoable } from './undoShortcut'

const press = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', {
    key: 'z',
    metaKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
})

test('⌘Z takes back the newest change of any source', () => {
  const organized = { at: undoStamp(), run: vi.fn() }
  const renamed = { at: undoStamp(), run: vi.fn() }
  let sources: (Undoable | null)[] = [organized, renamed]
  renderHook(() => useUndoShortcut(() => sources))
  expect(press().defaultPrevented).toBe(true)
  expect(renamed.run).toHaveBeenCalledTimes(1)
  expect(organized.run).not.toHaveBeenCalled()
  // The file operation is gone; the older organizing change is next
  sources = [organized, null]
  press()
  expect(organized.run).toHaveBeenCalledTimes(1)
  // Nothing left: the key is not taken
  sources = [null, null]
  expect(press().defaultPrevented).toBe(false)
})

test('a text field, an open dialog or menu, or another key keeps ⌘Z', () => {
  const change = { at: undoStamp(), run: vi.fn() }
  renderHook(() => useUndoShortcut(() => [change]))
  const field = document.body.appendChild(document.createElement('input'))
  press(field)
  const editor = document.body.appendChild(document.createElement('div'))
  editor.setAttribute('contenteditable', 'true')
  press(editor)
  press(document.body, { shiftKey: true })
  press(document.body, { key: 'y' })
  const menu = document.body.appendChild(document.createElement('div'))
  menu.setAttribute('role', 'menu')
  press()
  menu.remove()
  const dialog = document.body.appendChild(document.createElement('div'))
  dialog.setAttribute('aria-modal', 'true')
  press()
  dialog.remove()
  expect(change.run).not.toHaveBeenCalled()
  // A closed <dialog> keeps its attribute but owns nothing
  const closed = document.body.appendChild(document.createElement('dialog'))
  closed.setAttribute('aria-modal', 'true')
  press(document.body, { metaKey: false, ctrlKey: true })
  expect(change.run).toHaveBeenCalledTimes(1)
})
