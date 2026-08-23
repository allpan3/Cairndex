import { expect, test } from 'vitest'

import { importPartialSummary, importStoppedSummary } from './importActivity'

test('a batch that imported everything says nothing', () => {
  // Each file already announced itself with its own Undo; a summary on the happy
  // path would just be a second toast saying the same thing.
  expect(importPartialSummary({ imported: 3, skipped: 0, failed: 0 })).toBeNull()
})

test('a batch that lost a file says so, and why', () => {
  // The owner's case: two files picked, one arrived, and the only notice was a
  // transient toast that fired while they were watching a video (2026-08-23).
  const summary = importPartialSummary({
    imported: 1,
    skipped: 0,
    failed: 1,
    reason: 'Could not reach the server.',
  })

  expect(summary).toBe('Added 1 of 2 files — 1 failed. Could not reach the server.')
})

test('a skipped file counts against the total without claiming a failure', () => {
  expect(importPartialSummary({ imported: 2, skipped: 1, failed: 0 })).toBe(
    'Added 2 of 3 files — 1 skipped.',
  )
})

test('both kinds are reported together', () => {
  expect(importPartialSummary({ imported: 1, skipped: 1, failed: 1 })).toBe(
    'Added 1 of 3 files — 1 skipped, 1 failed.',
  )
})

test('a failure with no message still reports the count', () => {
  expect(importPartialSummary({ imported: 0, skipped: 0, failed: 2 })).toBe(
    'Added 0 of 2 files — 2 failed.',
  )
})

test('a stopped batch keeps its own wording', () => {
  // Distinct from the above: stopping is something the owner did, and the
  // message must not imply the imports that finished were undone.
  const summary = importStoppedSummary({
    imported: 1,
    skipped: 0,
    failed: 0,
    interrupted: 1,
    notAttempted: 1,
  })

  expect(summary).toContain('Import stopped')
  expect(summary).toContain('remain in the library')
})
