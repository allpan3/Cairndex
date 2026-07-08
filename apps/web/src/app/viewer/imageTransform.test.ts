import { describe, expect, test } from 'vitest'

import { clampScale, fitScale, nextFitMode, zoomToPoint } from './imageTransform'

describe('image transform math', () => {
  test('wheel zoom keeps the cursor point anchored', () => {
    const next = zoomToPoint({ scale: 1, tx: 0, ty: 0 }, 2, { x: 100, y: 50 })
    expect(next).toEqual({ scale: 2, tx: -100, ty: -50 })
  })

  test('double click cycles fit, actual, and fill', () => {
    expect(nextFitMode('fit')).toBe('actual')
    expect(nextFitMode('actual')).toBe('fill')
    expect(nextFitMode('fill')).toBe('fit')
    expect(nextFitMode('custom')).toBe('actual')
  })

  test('scale is clamped to fit-relative min and native max', () => {
    const fit = fitScale({ width: 400, height: 300 }, { width: 800, height: 600 })
    expect(clampScale(0.1, fit)).toBe(0.25)
    expect(clampScale(20, fit)).toBe(8)
  })
})
