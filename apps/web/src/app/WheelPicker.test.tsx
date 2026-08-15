import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { WheelPicker } from './WheelPicker'

const OPTIONS = [
  { value: 320, label: '320px' },
  { value: 480, label: '480px', note: 'default' },
  { value: 720, label: '720px' },
  { value: 960, label: '960px', note: 'native' },
]

function open(value = 480, onChange = vi.fn()) {
  render(<WheelPicker options={OPTIONS} value={value} onChange={onChange} label="Width" />)
  return { onChange }
}

test('renders every option, however many there are', () => {
  open()
  const group = screen.getByRole('radiogroup', { name: 'Width' })
  expect(group).toBeInTheDocument()
  expect(screen.getAllByRole('radio')).toHaveLength(4)
  expect(screen.getByRole('radio', { name: /320px/ })).toBeInTheDocument()
  expect(screen.getByRole('radio', { name: '960px, native' })).toBeInTheDocument()
})

test('marks the current value as checked and leaves the rest unchecked', () => {
  open(720)
  expect(screen.getByRole('radio', { name: /720px/ })).toBeChecked()
  expect(screen.getByRole('radio', { name: /320px/ })).not.toBeChecked()
})

test('clicking an option selects it', () => {
  const { onChange } = open()
  fireEvent.click(screen.getByRole('radio', { name: /960px/ }))
  expect(onChange).toHaveBeenCalledWith(960)
})

// Roving focus: the wheel is one tab stop, then arrows move within it.
test('only the selected option is in the tab order', () => {
  open(480)
  expect(screen.getByRole('radio', { name: /480px/ })).toHaveAttribute('tabindex', '0')
  expect(screen.getByRole('radio', { name: /320px/ })).toHaveAttribute('tabindex', '-1')
})

test('arrow keys step one value at a time', () => {
  const { onChange } = open(480)
  const group = screen.getByRole('radiogroup', { name: 'Width' })

  fireEvent.keyDown(group, { key: 'ArrowRight' })
  expect(onChange).toHaveBeenLastCalledWith(720)

  fireEvent.keyDown(group, { key: 'ArrowLeft' })
  expect(onChange).toHaveBeenLastCalledWith(320)
})

test('Home and End reach the ends', () => {
  const { onChange } = open(480)
  const group = screen.getByRole('radiogroup', { name: 'Width' })

  fireEvent.keyDown(group, { key: 'End' })
  expect(onChange).toHaveBeenLastCalledWith(960)

  fireEvent.keyDown(group, { key: 'Home' })
  expect(onChange).toHaveBeenLastCalledWith(320)
})

// Stepping past either end stays put rather than wrapping — a wheel of sizes
// has a smallest and a largest, and wrapping from one to the other is a jump
// nobody asked for.
test('does not wrap past the ends', () => {
  const { onChange } = open(320)
  const group = screen.getByRole('radiogroup', { name: 'Width' })
  fireEvent.keyDown(group, { key: 'ArrowLeft' })
  expect(onChange).not.toHaveBeenCalled()

  const last = open(960)
  fireEvent.keyDown(screen.getAllByRole('radiogroup')[1]!, { key: 'ArrowRight' })
  expect(last.onChange).not.toHaveBeenCalled()
})

// A value that is not on the wheel would otherwise index to -1 and check
// nothing; fall back to the first rung so something is always selected.
test('falls back to the first option for an unknown value', () => {
  open(9999)
  expect(screen.getByRole('radio', { name: /320px/ })).toBeChecked()
})
