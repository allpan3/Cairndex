import { expect, test } from 'vitest'

import type { JobRead } from '../api/client'
import { mergeJobRows, trackJobSnapshot, type LiveJobs } from './liveJobs'

function job(id: string, overrides: Partial<JobRead> = {}): JobRead {
  return {
    id,
    library_id: 'lib1',
    job_type: 'scan',
    status: 'running',
    phase: null,
    message: null,
    payload: {},
    processed: 0,
    total: null,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    finished_at: null,
    ...overrides,
  } as JobRead
}

test('two overlapping flows keep their own rows instead of one flipping between them', () => {
  // The reported break: Update pressed while a storyboard pass was running left
  // both pollers writing to a single slot, so one row's label, count and bar
  // each belonged to a different job every half second.
  let live: LiveJobs = {}
  live = trackJobSnapshot(live, job('sb', { job_type: 'storyboard', processed: 40, total: 300 }))
  live = trackJobSnapshot(live, job('scan', { status: 'queued' }))
  live = trackJobSnapshot(live, job('sb', { job_type: 'storyboard', processed: 41, total: 300 }))

  const rows = mergeJobRows([], live)
  expect(rows.map((row) => row.id)).toEqual(['sb', 'scan'])
  expect(rows[0]?.processed).toBe(41)
  expect(rows[1]?.status).toBe('queued')
})

test('a settling flow drops what finished and leaves live work alone', () => {
  let live: LiveJobs = {}
  live = trackJobSnapshot(live, job('probe', { job_type: 'probe', status: 'succeeded' }))
  live = trackJobSnapshot(live, job('scan'))

  live = trackJobSnapshot(live, null)

  expect(Object.keys(live)).toEqual(['scan'])
})

test('the same map comes back when a settling flow has nothing to drop', () => {
  // Identity matters: this feeds a memo and an effect, and a fresh object every
  // 500 ms would re-run both for no change.
  const live = trackJobSnapshot({}, job('scan'))
  expect(trackJobSnapshot(live, null)).toBe(live)
})

test('the server decides what exists; the local snapshot is only fresher', () => {
  const live = trackJobSnapshot({}, job('scan', { processed: 12 }))
  const rows = mergeJobRows(
    [job('scan', { processed: 4 }), job('sb', { job_type: 'storyboard' })],
    live,
  )

  expect(rows.map((row) => row.id)).toEqual(['scan', 'sb'])
  expect(rows[0]?.processed).toBe(12)
})

test('a job the server has not reported yet still shows', () => {
  // The first server poll of a freshly enqueued job can be a second away, and
  // the queue list stops polling entirely while it is empty.
  const live = trackJobSnapshot({}, job('scan', { status: 'queued' }))
  expect(mergeJobRows([], live).map((row) => row.id)).toEqual(['scan'])
})
