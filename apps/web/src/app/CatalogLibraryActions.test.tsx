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
    acknowledge: vi.fn(),
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
  const { container } = render(<DiscoveryNotice discovery={discovery({})} onComplete={vi.fn()} />)
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
      onComplete={vi.fn()}
    />,
  )

  expect(screen.getByRole('status')).toHaveTextContent('Updating12')
  expect(screen.getByRole('progressbar', { name: 'Update progress' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Update' }))
  expect(cancel).toHaveBeenCalledOnce()
})

// As v0.2.1's job rows: a finished run leaves the footer, and only the window
// that started it reports the result, once
test('a finished run leaves the footer and is reported once by the window that started it', () => {
  const run = {
    isPending: false,
    error: null,
    data: { id: 'run-1', state: 'succeeded', observed: 3, repaired: 1 },
  } as ReplicaDiscoveryState['run']
  const onComplete = vi.fn()
  const acknowledge = vi.fn()
  const { container, rerender } = render(
    <DiscoveryNotice discovery={discovery({ run, acknowledge })} onComplete={onComplete} />,
  )
  expect(container).toBeEmptyDOMElement()
  expect(onComplete).not.toHaveBeenCalled()

  rerender(
    <DiscoveryNotice
      discovery={discovery({ run, acknowledge, started: 'run-1' })}
      onComplete={onComplete}
    />,
  )
  expect(container).toBeEmptyDOMElement()
  expect(onComplete).toHaveBeenCalledExactlyOnceWith(
    'Update complete · 3 files checked · 1 links repaired',
  )
  // The row unmounts with the sidebar, so the hook is what forgets the run
  expect(acknowledge).toHaveBeenCalledOnce()
})

test('a cancelled run stays until the next one', () => {
  const run = {
    isPending: false,
    error: null,
    data: { id: 'run-1', state: 'cancelled', observed: 3, repaired: 0 },
  } as ReplicaDiscoveryState['run']
  render(<DiscoveryNotice discovery={discovery({ run })} onComplete={vi.fn()} />)

  expect(screen.getByRole('status')).toHaveTextContent('Update cancelled')
  expect(screen.getByText('Run Update to retry.')).toBeInTheDocument()
})

test('discovered files waiting for review offer the review', () => {
  const setOpen = vi.fn()
  render(<DiscoveryNotice discovery={discovery({ pending: true, setOpen })} onComplete={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: 'Review Discoveries…' }))
  expect(setOpen).toHaveBeenCalledWith(true)
})
