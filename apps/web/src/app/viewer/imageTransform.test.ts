import { describe, expect, test } from 'vitest'

import {
  clampPan,
  clampScale,
  fitScale,
  nextFitMode,
  scaleForMode,
  zoomToPoint,
} from './imageTransform'

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

  test('fit mode does not upscale smaller images', () => {
    const viewport = { width: 400, height: 300 }
    const image = { width: 100, height: 100 }

    expect(fitScale(viewport, image)).toBe(1)
    expect(scaleForMode('fit', viewport, image)).toBe(1)
    expect(scaleForMode('fill', viewport, image)).toBe(4)
  })

  test('pan is clamped to the visible bounds', () => {
    const next = clampPan(
      { scale: 2, tx: 1_000, ty: -1_000 },
      { width: 400, height: 300 },
      { width: 400, height: 300 },
    )

    expect(next).toEqual({ scale: 2, tx: 200, ty: -150 })
  })
})
