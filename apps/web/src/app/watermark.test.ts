import { afterEach, expect, test, vi } from 'vitest'

import {
  drawWatermark,
  renderWatermarkTile,
  watermarkFontSize,
  watermarkLabel,
  watermarkMargin,
  watermarkPlacement,
  type WatermarkCorner,
} from './watermark'

afterEach(() => {
  vi.restoreAllMocks()
})

/** A context that records what was drawn, standing in for a real canvas. */
function fakeContext(textWidth = 100) {
  const calls: { text: string; x: number; y: number; align: string; font: string }[] = []
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    measureText: vi.fn(() => ({ width: textWidth })),
    fillText: vi.fn((text: string, x: number, y: number) =>
      calls.push({ text, x, y, align: context.textAlign, font: context.font }),
    ),
    font: '',
    fillStyle: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'round',
    strokeText: vi.fn(),
    shadowBlur: 0,
    shadowOffsetY: 0,
  }
  return { context: context as unknown as CanvasRenderingContext2D, calls, spy: context }
}

const box = (corner: WatermarkCorner, width = 1000, height = 600) => ({
  left: 0,
  top: 0,
  width,
  height,
  corner,
})

// The mark is a fraction of the export's width, so it reads the same size on a
// small GIF as on a 4K still rather than shrinking away.
test('scales the mark with the export, with a floor', () => {
  expect(watermarkFontSize(1920)).toBe(37)
  expect(watermarkFontSize(3840)).toBe(74)
  expect(watermarkFontSize(480)).toBe(11)
  // Below the floor the ratio would give single-digit pixels.
  expect(watermarkFontSize(160)).toBe(11)
  expect(watermarkFontSize(0)).toBe(11)
})

test('tucks each corner against its own two edges', () => {
  const size = watermarkFontSize(1000)
  const margin = watermarkMargin(size)

  const bottomRight = watermarkPlacement(box('bottom-right'))
  expect(bottomRight.align).toBe('right')
  expect(bottomRight.x).toBe(1000 - margin)
  expect(bottomRight.y).toBeLessThan(600 - margin + 1)
  expect(bottomRight.y).toBeGreaterThan(600 - margin - size)

  const topRight = watermarkPlacement(box('top-right'))
  expect(topRight.align).toBe('right')
  expect(topRight.x).toBe(1000 - margin)
  expect(topRight.y).toBe(margin + size)

  const topLeft = watermarkPlacement(box('top-left'))
  expect(topLeft.align).toBe('left')
  expect(topLeft.x).toBe(margin)

  const bottomLeft = watermarkPlacement(box('bottom-left'))
  expect(bottomLeft.align).toBe('left')
  expect(bottomLeft.x).toBe(margin)
})

// The contact sheet tucks the mark into a header band far shorter than the
// sheet is wide; sized against the band it would be a fraction of the size it
// is on a snapshot of the same file.
test('sizes against scaleWidth when the box is not the whole export', () => {
  const placement = watermarkPlacement({ ...box('top-right', 300, 90), scaleWidth: 2048 })
  expect(placement.fontSize).toBe(watermarkFontSize(2048))
  // Still positioned inside the band it was given.
  expect(placement.x).toBe(300 - watermarkMargin(placement.fontSize))
})

test('an offset box places the mark inside it, not at the canvas edge', () => {
  const placement = watermarkPlacement({
    left: 100,
    top: 40,
    width: 500,
    height: 200,
    corner: 'bottom-right',
  })
  const margin = watermarkMargin(watermarkFontSize(500))
  expect(placement.x).toBe(600 - margin)
  expect(placement.y).toBeLessThan(240)
  expect(placement.y).toBeGreaterThan(200)
})

test('draws nothing when there is nothing to draw', () => {
  const { context, spy } = fakeContext()
  expect(drawWatermark(context, null, box('bottom-right'))).toBe(0)
  expect(drawWatermark(context, '', box('bottom-right'))).toBe(0)
  expect(spy.fillText).not.toHaveBeenCalled()
})

test('draws the mark and reports the width it occupied', () => {
  const { context, calls } = fakeContext(240)
  const occupied = drawWatermark(context, 'STUDIO', box('bottom-right', 1000, 600))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe('STUDIO')
  expect(calls[0]?.align).toBe('right')
  expect(occupied).toBe(240 + watermarkMargin(watermarkFontSize(1000)) * 2)
})

// A shadow alone is enough on dark and mid tones but leaves the mark barely
// there against pure white, which a snapshot can easily be.
test('outlines the mark so it reads over a bright frame too', () => {
  const { context, spy } = fakeContext(240)
  drawWatermark(context, 'STUDIO', box('bottom-right', 1000, 600))

  expect(spy.strokeText).toHaveBeenCalledWith('STUDIO', expect.any(Number), expect.any(Number))
  expect(spy.lineWidth).toBeGreaterThan(0)
  // Mitred corners on a heavy face throw spikes off the glyphs.
  expect(spy.lineJoin).toBe('round')
})

// Drawn through the shadow a second time it compounds into a grey smudge
// around letters that should be clean.
test('carries the shadow on the outline, not on the fill', () => {
  const { context, spy } = fakeContext(240)
  const blurWhenStroked: number[] = []
  spy.strokeText.mockImplementation(() => blurWhenStroked.push(spy.shadowBlur))

  drawWatermark(context, 'STUDIO', box('bottom-right', 1000, 600))

  expect(blurWhenStroked[0]).toBeGreaterThan(0)
  expect(spy.shadowBlur).toBe(0)
})

// Shadow and alignment are context-wide state; leaking them would put a drop
// shadow under every timestamp the contact sheet draws afterwards.
test('restores the context so the mark cannot bleed into later drawing', () => {
  const { context, spy } = fakeContext()
  drawWatermark(context, 'STUDIO', box('bottom-right'))
  expect(spy.save).toHaveBeenCalledOnce()
  expect(spy.restore).toHaveBeenCalledOnce()
})

test('reads the label from the preference, treating blank as off', () => {
  expect(watermarkLabel({ watermarkEnabled: true, watermarkText: 'STUDIO' })).toBe('STUDIO')
  expect(watermarkLabel({ watermarkEnabled: false, watermarkText: 'STUDIO' })).toBeNull()
  expect(watermarkLabel({ watermarkEnabled: true, watermarkText: '   ' })).toBeNull()
  expect(watermarkLabel({ watermarkEnabled: true, watermarkText: '' })).toBeNull()
  expect(watermarkLabel({ watermarkEnabled: true, watermarkText: '  STUDIO  ' })).toBe('STUDIO')
})

test('renders a tile just big enough for the mark and its inset', () => {
  const { context } = fakeContext(240)
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)

  const tile = renderWatermarkTile('STUDIO', 1920)
  const margin = watermarkMargin(watermarkFontSize(1920))
  expect(tile).not.toBeNull()
  expect(tile?.width).toBe(240 + margin * 2)
  expect(tile?.height).toBeGreaterThan(watermarkFontSize(1920))
})

test('renders no tile when the mark is off', () => {
  const createElement = vi.spyOn(document, 'createElement')
  expect(renderWatermarkTile(null, 1920)).toBeNull()
  expect(createElement).not.toHaveBeenCalled()
})
