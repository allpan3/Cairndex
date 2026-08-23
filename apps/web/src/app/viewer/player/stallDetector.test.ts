import { expect, test } from 'vitest'

import { createStallDetector, type StallSample } from './stallDetector'

const THRESHOLD = 15_000

function playing(overrides: Partial<StallSample> = {}): StallSample {
  return {
    paused: false,
    seeking: false,
    ended: false,
    playbackRate: 1,
    readyState: 4,
    currentTime: 10,
    bufferedSeconds: 30,
    ...overrides,
  }
}

/**
 * Feed the same sample once a second from `from` to `until` (inclusive, ms).
 * Returns the clock reading at which it reported a stall, or null if it never did.
 */
function runFrozen(
  detector: ReturnType<typeof createStallDetector>,
  sample: StallSample,
  { from, until }: { from: number; until: number },
): number | null {
  for (let now = from; now <= until; now += 1000) {
    if (detector.observe(sample, now)) return now
  }
  return null
}

test('a playhead frozen with a static buffer reports a stall at the threshold', () => {
  // The owner-reported wedge: last frame on screen, controls alive, no error
  // event, nothing in flight (2026-08-16).
  const detector = createStallDetector(THRESHOLD)
  detector.observe(playing({ currentTime: 10 }), 0)

  // Fifteen seconds after the last sign of progress, not a sample sooner.
  expect(runFrozen(detector, playing({ currentTime: 10 }), { from: 1000, until: 40_000 })).toBe(
    15_000,
  )
})

test('ordinary playback never reports a stall', () => {
  const detector = createStallDetector(THRESHOLD)
  for (let i = 0; i < 60; i++) {
    const stalled = detector.observe(
      playing({ currentTime: 10 + i, bufferedSeconds: 30 + i }),
      i * 1000,
    )
    expect(stalled).toBe(false)
  }
})

test('buffering with the buffer still filling is not a stall', () => {
  // The playhead is frozen — the player is waiting — but bytes keep arriving.
  // That is a slow network, which the loading state already explains; firing
  // here would replace a spinner that resolves with a card nobody needed.
  const detector = createStallDetector(THRESHOLD)
  for (let i = 0; i < 40; i++) {
    const stalled = detector.observe(
      playing({ currentTime: 10, bufferedSeconds: 30 + i * 0.5 }),
      i * 1000,
    )
    expect(stalled).toBe(false)
  }
})

test('a buffer that stops growing while the playhead sits still does stall', () => {
  const detector = createStallDetector(THRESHOLD)
  // Ten seconds of filling (last progress at t=9000), then the read dies.
  for (let i = 0; i < 10; i++) {
    detector.observe(playing({ currentTime: 10, bufferedSeconds: 30 + i }), i * 1000)
  }

  expect(
    runFrozen(detector, playing({ currentTime: 10, bufferedSeconds: 39 }), {
      from: 10_000,
      until: 40_000,
    }),
  ).toBe(24_000)
})

test.each([
  ['paused', { paused: true }],
  ['seeking', { seeking: true }],
  ['ended', { ended: true }],
  ['a zero playback rate', { playbackRate: 0 }],
  ['metadata not yet loaded', { readyState: 0 }],
])('%s freezes the clock legitimately and never stalls', (_label, overrides) => {
  const detector = createStallDetector(THRESHOLD)

  expect(runFrozen(detector, playing(overrides), { from: 0, until: 600_000 })).toBeNull()
})

test('a long pause does not bank time toward a stall once playback resumes', () => {
  // Pausing on a clip range's out-point lands here, via `paused`.
  const detector = createStallDetector(THRESHOLD)
  // Paused for two minutes; last "progress" is the final paused sample, t=119000.
  for (let i = 0; i < 120; i++) detector.observe(playing({ paused: true }), i * 1000)

  // Resumed and genuinely frozen: the countdown runs from the resume, not from
  // whenever the pause began, so nothing fires until 119000 + 15000.
  expect(
    runFrozen(detector, playing({ currentTime: 10 }), { from: 120_000, until: 133_000 }),
  ).toBeNull()
  expect(detector.observe(playing({ currentTime: 10 }), 134_000)).toBe(true)
})

test('it reports once per stall rather than every sample', () => {
  // The caller's recovery is budgeted (MAX_NATIVE_RECOVER); a detector that
  // re-fired every second would spend the whole budget before one reload had a
  // chance to work.
  const detector = createStallDetector(THRESHOLD)
  const frozen = playing({ currentTime: 10 })
  detector.observe(frozen, 0)

  const fired: number[] = []
  for (let now = 1000; now <= 40_000; now += 1000)
    if (detector.observe(frozen, now)) fired.push(now)

  // Once at the threshold, then once per further threshold — not every sample.
  expect(fired).toEqual([15_000, 30_000])
})

test('recovery resets the countdown as soon as anything moves', () => {
  const detector = createStallDetector(THRESHOLD)
  detector.observe(playing({ currentTime: 10 }), 0)
  for (let i = 1; i <= 14; i++) detector.observe(playing({ currentTime: 10 }), i * 1000)

  // One frame of progress at t=15000 resets it, so the next stall is a full
  // threshold from there rather than firing immediately.
  expect(detector.observe(playing({ currentTime: 10.5 }), 15_000)).toBe(false)
  expect(
    runFrozen(detector, playing({ currentTime: 10.5 }), { from: 16_000, until: 29_000 }),
  ).toBeNull()
  expect(detector.observe(playing({ currentTime: 10.5 }), 30_000)).toBe(true)
})

test('bytes landing in an earlier range count, even when the far end is static', () => {
  // Seeking forward then back leaves ranges like [[0,40],[1200,1205]]. The one
  // refilling is the *first*; watching only the last end would read a healthy
  // refill as a dead read — and it is exactly the state seeking past the
  // buffered region produces, so it would fire on the very gesture that
  // motivated this watchdog (owner repro, 2026-08-16).
  const detector = createStallDetector(THRESHOLD)
  for (let i = 0; i < 60; i++) {
    // Playhead pinned at the underrun point; total buffered still creeping up.
    const stalled = detector.observe(
      playing({ currentTime: 40, bufferedSeconds: 45 + i * 0.25 }),
      i * 1000,
    )
    expect(stalled).toBe(false)
  }
})

test('a clip loop jumping the playhead backward is progress, not a stall', () => {
  // useClipPlayback restarts at range.start, so the playhead moves *backward*
  // every cycle. Comparing with `>` instead of `!==` would read that as frozen
  // and card a video the owner is deliberately watching on loop.
  const detector = createStallDetector(THRESHOLD)
  for (let i = 0; i < 60; i++) {
    const t = 10 + (i % 3) * 0.4
    expect(detector.observe(playing({ currentTime: t, bufferedSeconds: 30 }), i * 1000)).toBe(false)
  }
})

test('a long gap between samples is not evidence of a stall', () => {
  // A throttled background tab, a suspended webview, or a slept machine leaves
  // one enormous gap. Nothing is known about that interval, so the first tick
  // on wake must not count it as a threshold the element failed to meet.
  const detector = createStallDetector(THRESHOLD, 4000)
  const frozen = playing({ currentTime: 10 })
  detector.observe(frozen, 0)
  detector.observe(frozen, 1000)

  // Woke up ten minutes later: restart the countdown rather than firing.
  expect(detector.observe(frozen, 600_000)).toBe(false)
  expect(runFrozen(detector, frozen, { from: 601_000, until: 614_000 })).toBeNull()
  expect(detector.observe(frozen, 615_000)).toBe(true)
})

test('the first sample never fires, however late the clock starts', () => {
  const detector = createStallDetector(THRESHOLD)

  expect(detector.observe(playing(), 900_000)).toBe(false)
})
