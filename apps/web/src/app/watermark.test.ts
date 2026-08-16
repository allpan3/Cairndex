import { afterEach, expect, test, vi } from 'vitest'

import { DEFAULT_EXPORT_PREFS } from '../state/exportPrefs'
import {
  cornerOrigin,
  drawWatermark,
  fitWithin,
  imageMarkSize,
  markSize,
  renderWatermarkTile,
  resetWatermarkImageCacheForTests,
  resolveWatermark,
  watermarkFontSize,
  watermarkMargin,
  type WatermarkCorner,
  type WatermarkMark,
} from './watermark'

afterEach(() => {
  vi.restoreAllMocks()
  resetWatermarkImageCacheForTests()
})

const TEXT: WatermarkMark = { kind: 'text', text: 'STUDIO' }

/** A picture mark of a given natural size, without decoding anything. */
function imageMark(naturalWidth: number, naturalHeight: number): WatermarkMark {
  return {
    kind: 'image',
    image: { width: naturalWidth, height: naturalHeight } as unknown as CanvasImageSource,
    naturalWidth,
    naturalHeight,
  }
}

/** A context that records what was drawn, standing in for a real canvas. */
function fakeContext(textWidth = 100) {
  const calls: { text: string; x: number; y: number; align: string; font: string }[] = []
  const images: { x: number; y: number; width: number; height: number; alpha: number }[] = []
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    measureText: vi.fn(() => ({ width: textWidth })),
    fillText: vi.fn((text: string, x: number, y: number) =>
      calls.push({ text, x, y, align: context.textAlign, font: context.font }),
    ),
    drawImage: vi.fn((_image: unknown, x: number, y: number, width: number, height: number) =>
      images.push({ x, y, width, height, alpha: context.globalAlpha }),
    ),
    strokeText: vi.fn(),
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'round',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    shadowBlur: 0,
    shadowOffsetY: 0,
  }
  return { context: context as unknown as CanvasRenderingContext2D, calls, images, spy: context }
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

// One calculation for both kinds is what keeps a picture and a word in exactly
// the same place, tucked against exactly the same two edges.
test('tucks each corner against its own two edges', () => {
  const size = { width: 200, height: 40 }
  const margin = 20

  expect(cornerOrigin(box('bottom-right'), size, margin)).toEqual({ x: 780, y: 540 })
  expect(cornerOrigin(box('top-right'), size, margin)).toEqual({ x: 780, y: 20 })
  expect(cornerOrigin(box('top-left'), size, margin)).toEqual({ x: 20, y: 20 })
  expect(cornerOrigin(box('bottom-left'), size, margin)).toEqual({ x: 20, y: 540 })
})

test('an offset box places the mark inside it, not at the canvas edge', () => {
  const origin = cornerOrigin(
    { left: 100, top: 40, width: 500, height: 200, corner: 'bottom-right' },
    { width: 120, height: 30 },
    10,
  )
  expect(origin).toEqual({ x: 470, y: 200 })
})

// A square badge scaled to a fixed width becomes enormously tall, and a long
// wordmark scaled to a fixed height runs off the frame — so both bounds apply.
test('fits a picture mark inside both a height and a width bound', () => {
  // Square: height decides, well inside the width bound.
  expect(imageMarkSize(400, 400, 1800)).toEqual({ width: 100, height: 100 })
  // Wide wordmark: the width bound takes over and the height comes down.
  const wide = imageMarkSize(4000, 200, 1800)
  expect(wide?.width).toBe(Math.round(1800 * 0.28))
  expect(wide?.height).toBe(Math.round(200 * (Math.round(1800 * 0.28) / 4000)))
  // Tall badge: height bound holds and the width stays small.
  const tall = imageMarkSize(200, 800, 1800)
  expect(tall?.height).toBe(100)
  expect(tall?.width).toBe(25)
})

test('a picture mark scales with the export, like the text does', () => {
  const small = imageMarkSize(400, 200, 480)
  const large = imageMarkSize(400, 200, 3840)
  expect(large!.height).toBeGreaterThan(small!.height * 5)
})

test('an undecoded picture has no size, and is not drawn as nothing', () => {
  expect(imageMarkSize(0, 0, 1920)).toBeNull()
  const { context, spy } = fakeContext()
  expect(drawWatermark(context, imageMark(0, 0), box('bottom-right'))).toBe(0)
  expect(spy.drawImage).not.toHaveBeenCalled()
})

test('draws nothing when there is nothing to draw', () => {
  const { context, spy } = fakeContext()
  expect(drawWatermark(context, null, box('bottom-right'))).toBe(0)
  expect(drawWatermark(context, { kind: 'text', text: '' }, box('bottom-right'))).toBe(0)
  expect(spy.fillText).not.toHaveBeenCalled()
})

test('draws the text mark and reports the width it occupied', () => {
  const { context, calls } = fakeContext(240)
  const occupied = drawWatermark(context, TEXT, box('bottom-right', 1000, 600))
  expect(calls).toHaveLength(1)
  expect(calls[0]?.text).toBe('STUDIO')
  expect(occupied).toBe(240 + watermarkMargin(watermarkFontSize(1000)) * 2)
})

test('draws the picture mark at its fitted size, in the same corner', () => {
  const { context, images } = fakeContext()
  const occupied = drawWatermark(context, imageMark(400, 200), box('bottom-right', 1000, 600))

  const size = imageMarkSize(400, 200, 1000)!
  const margin = watermarkMargin(watermarkFontSize(1000))
  expect(images).toHaveLength(1)
  expect(images[0]).toMatchObject({ width: size.width, height: size.height })
  expect(images[0]?.x).toBe(1000 - margin - size.width)
  expect(images[0]?.y).toBe(600 - margin - size.height)
  expect(occupied).toBe(size.width + margin * 2)
  // Composited nearly as given: a picture arrives already designed.
  expect(images[0]?.alpha).toBeGreaterThan(0.8)
  expect(images[0]?.alpha).toBeLessThan(1)
})

// A shadow alone is enough on dark and mid tones but leaves the mark barely
// there against pure white, which a snapshot can easily be.
test('outlines the text so it reads over a bright frame too', () => {
  const { context, spy } = fakeContext(240)
  drawWatermark(context, TEXT, box('bottom-right', 1000, 600))

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

  drawWatermark(context, TEXT, box('bottom-right', 1000, 600))

  expect(blurWhenStroked[0]).toBeGreaterThan(0)
  expect(spy.shadowBlur).toBe(0)
})

// A picture keeps the shadow: it is what stops a white logo disappearing into
// a white frame, the same job the text's outline does.
test('keeps the shadow under a picture mark', () => {
  const { context, spy } = fakeContext()
  const blurWhenDrawn: number[] = []
  spy.drawImage.mockImplementation(() => blurWhenDrawn.push(spy.shadowBlur))

  drawWatermark(context, imageMark(400, 200), box('bottom-right', 1000, 600))
  expect(blurWhenDrawn[0]).toBeGreaterThan(0)
})

// Shadow, alpha and alignment are context-wide state; leaking them would put a
// drop shadow under every timestamp the contact sheet draws afterwards.
test('restores the context so the mark cannot bleed into later drawing', () => {
  const { context, spy } = fakeContext()
  drawWatermark(context, TEXT, box('bottom-right'))
  expect(spy.save).toHaveBeenCalledOnce()
  expect(spy.restore).toHaveBeenCalledOnce()
})

test('the contact sheet band sizes against the sheet, not the band', () => {
  const { context } = fakeContext(150)
  const size = markSize(context, TEXT, 2048)
  // Height follows the font, which follows the sheet's own width.
  expect(size?.height).toBe(Math.round(watermarkFontSize(2048) * 1.2))
})

test('resolves the preference to words, treating blank as nothing', async () => {
  const on = { ...DEFAULT_EXPORT_PREFS, watermarkEnabled: true }
  await expect(resolveWatermark({ ...on, watermarkText: 'STUDIO' })).resolves.toEqual(TEXT)
  await expect(resolveWatermark({ ...on, watermarkText: '  STUDIO  ' })).resolves.toEqual(TEXT)
  await expect(resolveWatermark({ ...on, watermarkText: '   ' })).resolves.toBeNull()
  await expect(resolveWatermark({ ...on, watermarkText: '' })).resolves.toBeNull()
  await expect(
    resolveWatermark({ ...DEFAULT_EXPORT_PREFS, watermarkText: 'STUDIO' }),
  ).resolves.toBeNull()
})

// Choosing the image kind before picking a file must stamp nothing rather than
// falling back to the text that happens to be stored beside it.
test('resolves to nothing when the image kind has no image', async () => {
  await expect(
    resolveWatermark({
      ...DEFAULT_EXPORT_PREFS,
      watermarkEnabled: true,
      watermarkKind: 'image',
      watermarkText: 'STUDIO',
    }),
  ).resolves.toBeNull()
})

test('renders a tile just big enough for the mark and its inset', () => {
  const { context } = fakeContext(240)
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)

  const tile = renderWatermarkTile(TEXT, 1920)
  const margin = watermarkMargin(watermarkFontSize(1920))
  expect(tile).not.toBeNull()
  expect(tile?.width).toBe(240 + margin * 2)
  expect(tile?.height).toBeGreaterThan(watermarkFontSize(1920))
})

// The GIF's mark is a picture either way — the server never learns which kind
// it composited, which is why the image mark needed no server change.
test('renders a picture mark to a tile the same way', () => {
  const { context } = fakeContext()
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)

  const tile = renderWatermarkTile(imageMark(400, 200), 1920)
  const size = imageMarkSize(400, 200, 1920)!
  const margin = watermarkMargin(watermarkFontSize(1920))
  expect(tile?.width).toBe(size.width + margin * 2)
  expect(tile?.height).toBe(size.height + margin * 2)
})

test('renders no tile when the mark is off', () => {
  const createElement = vi.spyOn(document, 'createElement')
  expect(renderWatermarkTile(null, 1920)).toBeNull()
  expect(createElement).not.toHaveBeenCalled()
})

// --- fitting a mark to the band that holds it -------------------------------

test('leaves a mark that already fits alone', () => {
  const size = { width: 100, height: 40 }
  expect(fitWithin(size, box('top-right', 1000, 600), 20)).toBe(size)
})

// A picture mark is sized against the export's *width*, so nothing in that
// calculation knows how tall the box holding it is.
test('shrinks a mark too tall for its band, keeping its aspect', () => {
  const fitted = fitWithin({ width: 400, height: 200 }, box('top-right', 1000, 120), 20)
  // Band leaves 80px of room, so the height halves and the width follows.
  expect(fitted).toEqual({ width: 160, height: 80 })
})

test('shrinks a mark too wide for its band as well', () => {
  const fitted = fitWithin({ width: 400, height: 40 }, box('top-right', 240, 600), 20)
  expect(fitted).toEqual({ width: 200, height: 20 })
})

test('has nothing to draw when the padding leaves no room', () => {
  expect(fitWithin({ width: 10, height: 10 }, box('top-right', 30, 30), 20)).toBeNull()
})

// The header has a padding of its own that its metadata rows observe; left to
// default, the mark derived a larger inset from its own size and began lower
// than the text beside it (owner, 2026-08-16).
test('honours a box’s own padding over the mark’s default inset', () => {
  const { context, images } = fakeContext()
  drawWatermark(context, imageMark(400, 200), {
    left: 0,
    top: 0,
    width: 2048,
    height: 140,
    corner: 'top-right',
    margin: 25,
  })
  expect(images[0]?.y).toBe(25)
  // And not the inset it would have chosen for itself, whichever way that
  // happens to fall — the point is that the box's own padding won.
  expect(25).not.toBe(watermarkMargin(watermarkFontSize(2048)))
})

// The grid is drawn after the mark, so an overflowing mark was not merely
// low — its bottom was painted over.
test('keeps a tall picture mark inside the band it was given', () => {
  const { context, images } = fakeContext()
  const band = {
    left: 0,
    top: 0,
    width: 2048,
    height: 140,
    corner: 'top-right' as const,
    margin: 25,
  }
  drawWatermark(context, imageMark(400, 400), band)

  const drawn = images[0]
  expect(drawn).toBeDefined()
  expect(drawn!.y).toBe(25)
  expect(drawn!.y + drawn!.height).toBeLessThanOrEqual(band.height - 25)
})

// Glyphs only shrink if the font does; scaling a text mark's reported box
// alone would move it without making it any smaller.
test('shrinks the font when a text mark has to be fitted', () => {
  const { context, calls } = fakeContext(4000)
  drawWatermark(context, TEXT, { left: 0, top: 0, width: 600, height: 60, corner: 'top-right' })
  // Measured at 4000px wide against a 600px box, so it must have been scaled —
  // and the font it was actually drawn with must have come down with it.
  const drawnFont = calls[0]?.font ?? ''
  const size = Number(/(\d+)px/.exec(drawnFont)?.[1])
  expect(size).toBeLessThan(watermarkFontSize(600))
})
