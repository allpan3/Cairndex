import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { expect, test, vi } from 'vitest'
import { ConfirmDialog, PromptDialog } from './PromptDialog'
import { useModalDialog } from './useModalDialog'

// A child prompt must retain its parent's draft and return to its own opener
function Parent({ onClose }: { onClose: () => void }) {
  const { ref: dialogRef, close: closeDialog } = useModalDialog(onClose)
  const [child, setChild] = useState(false)
  return (
    <>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Parent">
        <input aria-label="Parent draft" autoFocus />
        <button onClick={() => setChild(true)}>Child</button>
        <button onClick={closeDialog}>Close parent</button>
      </div>
      {child && (
        <PromptDialog
          title="Child prompt"
          label="Child draft"
          onCancel={() => setChild(false)}
          onConfirm={() => undefined}
        />
      )}
    </>
  )
}

// The opener stays mounted so focus restoration can be observed after closing
function Harness() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open parent</button>
      {open && <Parent onClose={() => setOpen(false)} />}
    </>
  )
}

test('Tab wraps and Escape closes only the top dialog before restoring focus', async () => {
  render(<Harness />)
  const trigger = screen.getByRole('button', { name: 'Open parent' })
  trigger.focus()
  fireEvent.click(trigger)
  const parent = screen.getByRole('dialog', { name: 'Parent' })
  const draft = screen.getByRole('textbox', { name: 'Parent draft' })
  fireEvent.change(draft, { target: { value: 'Keep this draft' } })
  const close = within(parent).getByRole('button', { name: 'Close parent' })
  close.focus()
  fireEvent.keyDown(close, { key: 'Tab' })
  expect(draft).toHaveFocus()
  fireEvent.keyDown(draft, { key: 'Tab', shiftKey: true })
  expect(close).toHaveFocus()
  const child = within(parent).getByRole('button', { name: 'Child' })
  child.focus()
  fireEvent.click(child)
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Child draft' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Child prompt' })).not.toBeInTheDocument()
  expect(parent).toBeInTheDocument()
  expect(draft).toHaveValue('Keep this draft')
  await waitFor(() => expect(child).toHaveFocus())
  fireEvent.keyDown(child, { key: 'Escape' })
  await waitFor(() => expect(trigger).toHaveFocus())
})

test('Escape and backdrop cannot dismiss an operation whose confirmation is pending', () => {
  const cancel = vi.fn()
  render(
    <ConfirmDialog
      title="Working"
      body="Pending confirmation"
      pending
      onCancel={cancel}
      onConfirm={() => undefined}
    />,
  )
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.mouseDown(document.querySelector('.modal-backdrop')!)
  expect(cancel).not.toHaveBeenCalled()
})
