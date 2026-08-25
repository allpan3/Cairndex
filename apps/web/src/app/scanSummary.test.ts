import { expect, test } from 'vitest'

import type { JobRead } from '../api/client'
import { scanCompleteMessage, scanOutcome } from './scanSummary'

function finishedScan(result: unknown): JobRead {
  return { result } as JobRead
}

test('reads both counts a finished scan reports', () => {
  expect(scanOutcome(finishedScan({ missing_total: 3, forgotten: 2 }))).toEqual({
    missingTotal: 3,
    forgotten: 2,
  })
})

test('a payload without the keys reads as zero rather than as an error', () => {
  // An older server, or a run that was cancelled before it summarized.
  expect(scanOutcome(finishedScan({}))).toEqual({ missingTotal: 0, forgotten: 0 })
  expect(scanOutcome(finishedScan(null))).toEqual({ missingTotal: 0, forgotten: 0 })
  expect(scanOutcome(finishedScan({ missing_total: 'many', forgotten: -1 }))).toEqual({
    missingTotal: 0,
    forgotten: 0,
  })
})

test('says nothing about forgetting when nothing was forgotten', () => {
  // A library nobody has deleted from should not carry a permanent report about
  // a mechanism the owner never has to think about.
  expect(scanCompleteMessage({ missingTotal: 0, forgotten: 0 })).toBe(
    'Scan complete: 0 linked files are missing.',
  )
  expect(scanCompleteMessage({ missingTotal: 1, forgotten: 0 })).toBe(
    'Scan complete: 1 linked file is missing.',
  )
})

test('reports what it dropped, so the sweep is visible where the owner looks', () => {
  expect(scanCompleteMessage({ missingTotal: 0, forgotten: 1 })).toBe(
    'Scan complete: 0 linked files are missing. Forgot 1 unbundled file that is gone.',
  )
  expect(scanCompleteMessage({ missingTotal: 2, forgotten: 5 })).toBe(
    'Scan complete: 2 linked files are missing. Forgot 5 unbundled files that are gone.',
  )
})
