import { render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ensureHostNotificationPermission, notifyHost, setHostBadgeCount } from '../platform'
import { resetJobNotificationsForTests } from './useJobNotifications'
import { usePortableJobNotifications } from './usePortableJobNotifications'

vi.mock('../platform', () => ({
  isDesktopHost: vi.fn(() => true),
  ensureHostNotificationPermission: vi.fn().mockResolvedValue(true),
  notifyHost: vi.fn().mockResolvedValue(undefined),
  setHostBadgeCount: vi.fn().mockResolvedValue(undefined),
}))

type Run = NonNullable<Parameters<typeof usePortableJobNotifications>[1]>
type Work = NonNullable<Parameters<typeof usePortableJobNotifications>[2]>
function Harness({ run, work }: { run?: Run; work?: Work }) {
  usePortableJobNotifications('synthetic', run, work)
  return null
}
const running = { id: 'scan', state: 'running' } as Run
const succeeded = { id: 'scan', state: 'succeeded' } as Run

beforeEach(() => {
  vi.clearAllMocks()
  resetJobNotificationsForTests()
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
})
afterEach(() => {
  resetJobNotificationsForTests()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test('overlapping portable passes settle once and retained success does not notify again', async () => {
  const probe: Work = { kind: 'probe', job: { id: 'probe', state: 'running' } }
  const view = render(<Harness run={running} work={probe} />)
  expect(ensureHostNotificationPermission).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(11_000)
  view.rerender(<Harness run={succeeded} work={probe} />)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(notifyHost).not.toHaveBeenCalled()
  const complete: Work = { ...probe, job: { id: 'probe', state: 'succeeded' } }
  view.rerender(<Harness run={succeeded} work={complete} />)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(notifyHost).toHaveBeenCalledWith('Cairndex finished', 'Scan and Media analysis complete.')
  expect(setHostBadgeCount).toHaveBeenCalledWith(1)
  view.rerender(<Harness run={{ ...succeeded }} work={{ ...complete }} />)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(notifyHost).toHaveBeenCalledTimes(1)
  view.unmount()
})

test('an earlier retained failure does not mark new work failed', async () => {
  const old: Work = { kind: 'storyboards', job: { id: 'old', state: 'failed' } }
  const view = render(<Harness run={running} work={old} />)
  await vi.advanceTimersByTimeAsync(11_000)
  view.rerender(<Harness run={succeeded} work={old} />)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(notifyHost).toHaveBeenCalledWith('Cairndex finished', 'Scan complete.')
  view.unmount()
})

test('failure in a pass this window observed is reported after it stops', async () => {
  const view = render(<Harness run={running} />)
  await vi.advanceTimersByTimeAsync(11_000)
  view.rerender(<Harness run={{ ...running, state: 'failed' }} />)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(notifyHost).toHaveBeenCalledWith(
    'Cairndex ran into a problem',
    'Scan did not finish cleanly.',
  )
  view.unmount()
})
