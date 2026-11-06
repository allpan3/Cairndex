import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { StorageAccessDialog } from './StorageAccessDialog'

test('access opens as a dismissible dialog and retries authorization without background prompts', async () => {
  const authorize = vi
    .fn()
    .mockRejectedValueOnce(new Error('Access was refused'))
    .mockResolvedValue(undefined)
  const onAuthorized = vi.fn()
  render(
    <StorageAccessDialog
      access="authorization"
      authorize={authorize}
      onAuthorized={onAuthorized}
    />,
  )
  expect(screen.getByRole('dialog', { name: 'Network Share Access' })).toBeVisible()
  expect(authorize).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Network Share Access…' }))
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  expect(await screen.findByText('Access was refused')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Allow Access…' }))
  await waitFor(() => expect(onAuthorized).toHaveBeenCalledOnce())
  expect(screen.queryByRole('dialog')).toBeNull()
})
