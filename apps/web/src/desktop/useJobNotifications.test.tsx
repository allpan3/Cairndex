import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import type { JobRead } from '../api/client'
import {
  ensureHostNotificationPermission,
  isDesktopHost,
  notifyHost,
  setHostBadgeCount,
} from '../platform'
import { accumulateRun, isNotableRun, runNotification, LONG_RUN_MS } from './jobRun'
import { useJobNotifications } from './useJobNotifications'

vi.mock('../platform', () => ({
  isDesktopHost: vi.fn(() => true),
  ensureHostNotificationPermission: vi.fn().mockResolvedValue(true),
  notifyHost: vi.fn().mockResolvedValue(undefined),
  setHostBadgeCount: vi.fn().mockResolvedValue(undefined),
}))

const START = '2026-07-19T12:00:00.000Z'

function job(overrides: Partial<JobRead> = {}): JobRead {
  return {
    id: 'j1',
    job_type: 'scan',
    status: 'running',
    library_id: 'lib-1',
    created_at: START,
    started_at: START,
    finished_at: null,
    error: null,
    message: null,
    phase: null,
    processed: 0,
    total: null,
    payload: {},
    result: null,
    cancel_requested: false,
    ...overrides,
  } as JobRead
}

function Harness({ activeJob }: { activeJob: JobRead | null }) {
  useJobNotifications(activeJob)
  return null
}

describe('run accumulation', () => {
  test('collects distinct job types across a chained run', () => {
    const now = Date.parse(START)
    let run = accumulateRun(null, job({ job_type: 'scan' }), now)
    run = accumulateRun(run, job({ job_type: 'scan' }), now)
    run = accumulateRun(run, job({ job_type: 'probe' }), now)
    run = accumulateRun(run, job({ job_type: 'storyboard' }), now)
    // The Update flow chains three jobs for one user action; the run keeps them
    // in order and does not repeat a type.
    expect(run.types).toEqual(['scan', 'probe', 'storyboard'])
    expect(run.startedAt).toBe(now)
    expect(run.failed).toBe(false)
  })

  test('measures from the server start time, not first poll', () => {
    // A run queued behind another job must be measured by when it actually ran.
    const run = accumulateRun(null, job(), Date.parse(START) + 60_000)
    expect(run.startedAt).toBe(Date.parse(START))
  })

  test('treats a failure as notable but a cancellation as not a failure', () => {
    const now = Date.parse(START)
    expect(accumulateRun(null, job({ status: 'failed' }), now).failed).toBe(true)
    // Cancelling is a deliberate user action, not something to report as a problem.
    expect(accumulateRun(null, job({ status: 'cancelled' }), now).failed).toBe(false)
  })

  test('only reports runs long enough that the user might have walked away', () => {
    const run = accumulateRun(null, job(), Date.parse(START))
    expect(isNotableRun(run, run.startedAt + LONG_RUN_MS - 1)).toBe(false)
    expect(isNotableRun(run, run.startedAt + LONG_RUN_MS)).toBe(true)
  })

  test('describes what ran in readable prose', () => {
    const now = Date.parse(START)
    let run = accumulateRun(null, job({ job_type: 'scan' }), now)
    expect(runNotification(run).body).toBe('Scan complete.')
    run = accumulateRun(run, job({ job_type: 'probe' }), now)
    expect(runNotification(run).body).toBe('Scan and Media analysis complete.')
    run = accumulateRun(run, job({ job_type: 'storyboard' }), now)
    expect(runNotification(run).body).toBe('Scan, Media analysis and Storyboards complete.')
    expect(runNotification({ ...run, failed: true }).title).toMatch(/problem/i)
  })
})

describe('notification delivery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(isDesktopHost).mockReturnValue(true)
    vi.useFakeTimers()
    // Default to "user is away" so the interesting path runs.
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  test('notifies once for a long chained run', async () => {
    const started = job({ started_at: new Date(Date.now() - 30_000).toISOString() })
    const view = render(<Harness activeJob={started} />)
    view.rerender(
      <Harness activeJob={job({ job_type: 'probe', started_at: started.started_at })} />,
    )
    // A gap between chained stages must not end the run early.
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(500)
    expect(notifyHost).not.toHaveBeenCalled()

    view.rerender(
      <Harness activeJob={job({ job_type: 'storyboard', started_at: started.started_at })} />,
    )
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(2_000)

    expect(notifyHost).toHaveBeenCalledTimes(1)
    expect(notifyHost).toHaveBeenCalledWith('Cairndex finished', expect.stringContaining('Scan'))
    expect(setHostBadgeCount).toHaveBeenCalledWith(1)
  })

  test('stays silent for a short run', async () => {
    const view = render(<Harness activeJob={job({ started_at: new Date().toISOString() })} />)
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifyHost).not.toHaveBeenCalled()
  })

  test('stays silent while the user is watching', async () => {
    // Telling someone a job finished while they watch its progress bar is noise.
    vi.mocked(document.hasFocus).mockReturnValue(true)
    const view = render(
      <Harness activeJob={job({ started_at: new Date(Date.now() - 30_000).toISOString() })} />,
    )
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifyHost).not.toHaveBeenCalled()
  })

  test('requests permission when a run starts, not at launch', async () => {
    render(<Harness activeJob={null} />)
    expect(ensureHostNotificationPermission).not.toHaveBeenCalled()

    const view = render(<Harness activeJob={job()} />)
    expect(ensureHostNotificationPermission).toHaveBeenCalledTimes(1)
    // Asking again on every poll would be wrong; once per session is enough.
    view.rerender(<Harness activeJob={job({ processed: 5 })} />)
    expect(ensureHostNotificationPermission).toHaveBeenCalledTimes(1)
  })

  test('reports a failed run differently', async () => {
    const old = new Date(Date.now() - 30_000).toISOString()
    const view = render(<Harness activeJob={job({ started_at: old })} />)
    view.rerender(<Harness activeJob={job({ started_at: old, status: 'failed' })} />)
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifyHost).toHaveBeenCalledWith(
      'Cairndex ran into a problem',
      expect.stringContaining('not finish cleanly'),
    )
  })

  test('stays inert in the browser', async () => {
    vi.mocked(isDesktopHost).mockReturnValue(false)
    const view = render(
      <Harness activeJob={job({ started_at: new Date(Date.now() - 30_000).toISOString() })} />,
    )
    view.rerender(<Harness activeJob={null} />)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(notifyHost).not.toHaveBeenCalled()
    expect(ensureHostNotificationPermission).not.toHaveBeenCalled()
  })
})
