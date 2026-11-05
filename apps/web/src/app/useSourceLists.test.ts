import { expect, test } from 'vitest'
import type { SourceJob } from '../api/sourceOperations'
import { rejectedName } from './useSourceLists'

test('old rejected names stay out of recovery, but started writes and copy conflicts remain', () => {
  const job = {
    action: 'rename',
    state: 'interrupted',
    error: 'Destination exists',
    result: null,
  } as SourceJob
  expect(rejectedName(job)).toBe(true)
  expect(rejectedName({ ...job, action: 'mkdir' })).toBe(true)
  expect(rejectedName({ ...job, result: { started: true } })).toBe(false)
  expect(rejectedName({ ...job, action: 'copy' })).toBe(false)
  expect(rejectedName({ ...job, state: 'prepared' })).toBe(false)
  expect(rejectedName({ ...job, error: 'Write mode is off' })).toBe(false)
})
