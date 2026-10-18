import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { expect, test } from 'vitest'

import { useNavigationHistory } from './useNavigationHistory'

const same = (a: string, b: string) => a === b

function Places() {
  const [place, setPlace] = useState('all')
  const history = useNavigationHistory(place, same, setPlace)
  return (
    <>
      {history}
      <output>{place}</output>
      {['shelf', 'files'].map((next) => (
        <button key={next} onClick={() => setPlace(next)}>
          Go {next}
        </button>
      ))}
    </>
  )
}

const back = () => screen.getByRole('button', { name: 'Back' })
const forward = () => screen.getByRole('button', { name: 'Forward' })
const place = () => screen.getByRole('status').textContent

test('Back and Forward retrace places without recording themselves', () => {
  render(<Places />)
  expect(back()).toBeDisabled()
  expect(forward()).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Go shelf' }))
  fireEvent.click(screen.getByRole('button', { name: 'Go files' }))

  fireEvent.click(back())
  expect(place()).toBe('shelf')
  fireEvent.click(back())
  expect(place()).toBe('all')
  expect(back()).toBeDisabled()
  fireEvent.click(forward())
  expect(place()).toBe('shelf')
  expect(forward()).toBeEnabled()

  // A new place after going back drops the places ahead, as a browser does
  fireEvent.click(screen.getByRole('button', { name: 'Go files' }))
  expect(forward()).toBeDisabled()
  fireEvent.click(back())
  expect(place()).toBe('shelf')
})
