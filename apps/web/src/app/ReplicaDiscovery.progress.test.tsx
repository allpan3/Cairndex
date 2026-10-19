import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { DiscoveryRun } from '../api/discovery'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'
import { DiscoveryNotice } from './ReplicaDiscovery'

function notice(run: DiscoveryRun) {
  const cancel = vi.fn()
  const discovery = {
    run: { data: run },
    running: true,
    cancel,
    busy: false,
    pending: false,
    finished: null,
    clearFinished: vi.fn(),
  } as unknown as ReplicaDiscoveryState
  render(<DiscoveryNotice discovery={discovery} onComplete={vi.fn()} />)
  return cancel
}

test('enumeration states that its total is unknown and remains cancellable', () => {
  const cancel = notice({ state: 'running', phase: 'walk', observed: 64, total: null })
  expect(screen.getByText('Finding files · total not yet known')).toBeVisible()
  expect(screen.getByText('64 found')).toBeVisible()
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Update' }))
  expect(cancel).toHaveBeenCalledOnce()
})

test('a known phase shows completed/total and a determinate accessible bar', () => {
  notice({ state: 'running', phase: 'known', observed: 150, completed: 32, total: 120 })
  expect(screen.getByText('Checking cataloged files')).toBeVisible()
  expect(screen.getByText('32 / 120')).toBeVisible()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '32')
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '120')
  expect(screen.getByRole('progressbar')).not.toHaveClass('job-progress__track--indeterminate')
})
