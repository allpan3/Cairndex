import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import { CatalogLibraryActions } from './CatalogLibraryActions'
import { DiscoveryNotice } from './ReplicaDiscovery'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'

test('the library menu lists its entries and runs the chosen one', () => {
  const review = vi.fn()
  render(
    <CatalogLibraryActions
      update={{ running: false, disabled: false, onClick: vi.fn() }}
      items={[
        { label: 'Add Files…', onClick: vi.fn() },
        null,
        { label: 'Metadata Review', onClick: review },
      ]}
    />,
  )

  expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'More library actions' }))
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
    'Add Files…',
    'Metadata Review',
  ])
  fireEvent.click(screen.getByRole('menuitem', { name: 'Metadata Review' }))
  expect(review).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
})

function discovery(overrides: Partial<ReplicaDiscoveryState>): ReplicaDiscoveryState {
  return {
    run: { isPending: false, error: null, data: { id: 'run-1', state: 'idle' } },
    started: null,
    error: '',
    busy: false,
    running: false,
    pending: false,
    cancel: vi.fn(),
    setOpen: vi.fn(),
    ...overrides,
  } as unknown as ReplicaDiscoveryState
}

test('an idle Update with nothing to review adds nothing to the sidebar', () => {
  const { container } = render(<DiscoveryNotice discovery={discovery({})} />)
  expect(container).toBeEmptyDOMElement()
})

test('a running Update shows its progress and can be cancelled', () => {
  const cancel = vi.fn()
  render(
    <DiscoveryNotice
      discovery={discovery({
        running: true,
        cancel,
        run: {
          isPending: false,
          error: null,
          data: { id: 'run-1', state: 'running', observed: 12, repaired: 0 },
        } as ReplicaDiscoveryState['run'],
      })}
    />,
  )

  expect(screen.getByRole('status')).toHaveTextContent('Updating · 12 files checked')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Update' }))
  expect(cancel).toHaveBeenCalledOnce()
})

test('a finished run is reported only in the window that started it', () => {
  const run = {
    isPending: false,
    error: null,
    data: { id: 'run-1', state: 'succeeded', observed: 3, repaired: 1 },
  } as ReplicaDiscoveryState['run']
  const { container, rerender } = render(<DiscoveryNotice discovery={discovery({ run })} />)
  expect(container).toBeEmptyDOMElement()

  rerender(<DiscoveryNotice discovery={discovery({ run, started: 'run-1' })} />)
  expect(screen.getByRole('status')).toHaveTextContent('Update complete · 3 files checked')
})

test('discovered files waiting for review offer the review', () => {
  const setOpen = vi.fn()
  render(<DiscoveryNotice discovery={discovery({ pending: true, setOpen })} />)

  fireEvent.click(screen.getByRole('button', { name: 'Review Discoveries…' }))
  expect(setOpen).toHaveBeenCalledWith(true)
})
