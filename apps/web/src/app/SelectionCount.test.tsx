import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'

import { SelectionCount } from './SelectionCount'

test('counts a multiple selection beside the total and explains a partial Select All', () => {
  const { rerender } = render(
    <SelectionCount total={2269} selected={1} loaded={100} more noun="bundles" />,
  )
  expect(screen.getByText(/items/)).toHaveTextContent(/^2,269 items$/)
  expect(screen.getByText(/items/)).not.toHaveAttribute('title')
  rerender(<SelectionCount total={2269} selected={100} loaded={100} more noun="bundles" />)
  expect(screen.getByRole('status')).toHaveTextContent(
    '· 100 selected. Select All selects the 100 loaded bundles',
  )
  expect(screen.getByText(/items/)).toHaveAttribute(
    'title',
    'Select All selects the 100 loaded bundles',
  )
  rerender(<SelectionCount total={40} selected={40} loaded={40} more={false} noun="bundles" />)
  expect(screen.getByRole('status')).toHaveTextContent(/^· 40 selected$/)
  expect(screen.getByText(/items/)).not.toHaveAttribute('title')
})
