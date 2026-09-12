import { expect, test } from 'vitest'
import { createPlaybackJournal } from './usePlaybackDiagnostics'

// Bounded timelines retain ordering and account for evicted observations
test('keeps the newest 600 events with relative timing and an eviction count', () => {
  let now = 1000
  const journal = createPlaybackJournal(() => now)
  for (let i = 0; i < 605; i += 1) {
    now += 10
    journal.record('sample', { index: i })
  }
  const snapshot = JSON.parse(journal.snapshot())
  expect(snapshot.dropped).toBe(5)
  expect(snapshot.events).toHaveLength(600)
  expect(snapshot.events[0]).toEqual({ event: 'sample', atMs: 60, index: 5 })
  expect(snapshot.events.at(-1)).toEqual({ event: 'sample', atMs: 6050, index: 604 })
})
