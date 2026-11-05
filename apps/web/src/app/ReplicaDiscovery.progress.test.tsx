import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { DiscoveryRun } from '../api/discovery'
import type { ReplicaDiscoveryState } from './useReplicaDiscovery'
import { DiscoveryNotice } from './ReplicaDiscovery'

function notice(run: DiscoveryRun) {
  const cancel = vi.fn()
  const discovery = {
    run: { data: run },
    running: run.state === 'running',
    cancel,
    busy: false,
    pending: false,
    finished: null,
    clearFinished: vi.fn(),
  } as unknown as ReplicaDiscoveryState
  render(<DiscoveryNotice discovery={discovery} onComplete={vi.fn()} />)
  return cancel
}

test('enumeration shows its observed count without a total and remains cancellable', () => {
  const cancel = notice({ state: 'running', phase: 'walk', observed: 64, total: null })
  expect(screen.getByText('Finding files')).toBeVisible()
  expect(screen.queryByText(/not yet known/)).toBeNull()
  expect(screen.getByText('64 found')).toBeVisible()
  expect(screen.getByRole('progressbar')).not.toHaveAttribute('aria-valuenow')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel Update' }))
  expect(cancel).toHaveBeenCalledOnce()
})

test('initial scanning explains the server scope while preserving phase progress', () => {
  notice({ state: 'running', initial_scan: true, phase: 'known', completed: 4, total: 12 })
  expect(screen.getByText('Initial library scan')).toBeVisible()
  expect(screen.getByText(/Large libraries can take several minutes/)).toBeVisible()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4')
  fireEvent.click(screen.getByText('About initial setup'))
  expect(screen.getByText(/Browsers using this server share/)).toBeVisible()
})

test('an established library can still be waiting for its first local scan', () => {
  notice({ state: 'idle', initial_scan: true })
  expect(screen.getByText('Files not scanned on this server yet')).toBeVisible()
  expect(screen.getByText(/Your saved organization is already available/)).toBeVisible()
  expect(screen.queryByRole('progressbar')).toBeNull()
})

test('a cancelled initial scan retains setup context and offers a retry', () => {
  notice({ state: 'cancelled', initial_scan: true })
  expect(screen.getByText('Initial scan cancelled')).toBeVisible()
  expect(screen.getByText('Run Update to retry.')).toBeVisible()
})

test('ordinary Updates keep the compact progress display', () => {
  notice({ state: 'running', initial_scan: false, phase: 'walk', observed: 64 })
  expect(screen.queryByText('Initial library scan')).toBeNull()
  expect(screen.queryByText('About initial setup')).toBeNull()
  expect(screen.getByText('Finding files')).toBeVisible()
})

test('a known phase shows completed/total and a determinate accessible bar', () => {
  notice({ state: 'running', phase: 'known', observed: 150, completed: 32, total: 120 })
  expect(screen.getByText('Checking cataloged files')).toBeVisible()
  expect(screen.getByText('32 / 120')).toBeVisible()
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '32')
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '120')
  expect(screen.getByRole('progressbar')).not.toHaveClass('job-progress__track--indeterminate')
})
