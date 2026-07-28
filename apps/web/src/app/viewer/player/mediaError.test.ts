import { expect, test } from 'vitest'

import { classifyMediaError } from './mediaError'

// The four MediaError codes, by their spec numbers.
const ABORTED = 1
const NETWORK = 2
const DECODE = 3
const SRC_NOT_SUPPORTED = 4

const err = (code: number) => ({ code, message: '' }) as MediaError

test('a format the engine refused is not retryable', () => {
  // The hev1-tagged HEVC case: AVFoundation rejects the source outright, so
  // every reload reproduces it. Offering "Try again" here is a button that
  // cannot work, and the old copy blamed the network for a codec problem.
  expect(classifyMediaError(err(SRC_NOT_SUPPORTED))).toBe('unsupported')
  expect(classifyMediaError(err(DECODE))).toBe('unsupported')
})

test('a delivery failure stays retryable', () => {
  // A dropped or aborted read is exactly what reloading at the playhead fixes.
  expect(classifyMediaError(err(NETWORK))).toBe('interrupted')
  expect(classifyMediaError(err(ABORTED))).toBe('interrupted')
})

test('an unexplained failure keeps the retry', () => {
  // No error object: the load watchdog fires without one, and a wedged read is
  // the case it exists for. Withholding a retry that would have worked is worse
  // than offering one that does not.
  expect(classifyMediaError(null)).toBe('interrupted')
  expect(classifyMediaError(undefined)).toBe('interrupted')
})
