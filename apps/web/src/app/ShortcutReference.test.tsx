import { render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { ShortcutReference } from './ShortcutReference'
import { formatAccelerator } from '../platform/keymap'

test('renders shared video keys and clearly scopes desktop-only accelerators', () => {
  render(<ShortcutReference />)
  const reference = screen.getByRole('region', { name: 'Keyboard shortcuts' })
  expect(within(reference).getByText('Space / K')).toBeVisible()
  expect(within(reference).getByText('Subtitles').parentElement).toHaveTextContent('V')
  expect(within(reference).getByText('Increase Speed').parentElement).toHaveTextContent('C')
  expect(
    within(reference).getByText(/These shortcuts are available in the desktop app/),
  ).toBeVisible()
  expect(reference).toHaveAttribute('tabindex', '0')
})

test('formats modifier combinations using platform conventions', () => {
  expect(formatAccelerator('CmdOrCtrl+Shift+N', true)).toBe('⌘⇧N')
  expect(formatAccelerator('Ctrl+Cmd+F', true)).toBe('⌃⌘F')
  expect(formatAccelerator('CmdOrCtrl+Shift+N', false)).toBe('Ctrl+Shift+N')
})
