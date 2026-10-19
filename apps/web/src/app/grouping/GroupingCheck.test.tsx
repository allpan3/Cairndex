import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { GroupingCheck } from './GroupingNodeRow'

function PendingSelection({ acknowledge }: { acknowledge: boolean }) {
  const [pending, setPending] = useState(false)
  const [selected, setSelected] = useState(false)
  return (
    <>
      <GroupingCheck
        selected={Number(selected)}
        total={1}
        disabled={pending}
        label="Synthetic selection"
        change={() => setPending(true)}
      />
      <button
        onClick={() => {
          setSelected(acknowledge)
          setPending(false)
        }}
      >
        Finish worker
      </button>
    </>
  )
}

describe('grouping selection awaiting a durable edit', () => {
  it.each([true, false])(
    'keeps the click visible and reconciles acknowledgement=%s',
    (acknowledge) => {
      render(<PendingSelection acknowledge={acknowledge} />)
      const checkbox = screen.getByRole('checkbox', {
        name: 'Synthetic selection',
      }) as HTMLInputElement
      fireEvent.click(checkbox)
      expect(checkbox.checked).toBe(true)
      expect(checkbox.disabled).toBe(true)
      fireEvent.click(screen.getByRole('button', { name: 'Finish worker' }))
      expect(checkbox.checked).toBe(acknowledge)
      expect(checkbox.disabled).toBe(false)
    },
  )
})
