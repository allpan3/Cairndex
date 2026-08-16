import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  importWatermarkImage,
  loadImage,
  MAX_WATERMARK_FILE_BYTES,
  MAX_WATERMARK_STORED_EDGE,
  WATERMARK_FILE_ACCEPT,
  WatermarkImageError,
} from './watermarkImage'

/** The natural size the next decoded image reports. */
let decodedSize = { width: 64, height: 32 }
let decodeFails = false

beforeEach(() => {
  decodedSize = { width: 64, height: 32 }
  decodeFails = false

  /**
   * jsdom loads nothing, so `Image` is stubbed to fire its own load event.
   *
   * `decode()` is deliberately left throwing: the loader must never reach for
   * it, because in a window that is not painting it can hang forever (see
   * `loadImage`), and a test that stubbed it would hide that.
   */
  class FakeImage {
    naturalWidth = 0
    naturalHeight = 0
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    #src = ''
    get src() {
      return this.#src
    }
    set src(value: string) {
      this.#src = value
      queueMicrotask(() => {
        if (decodeFails) {
          this.onerror?.()
          return
        }
        this.naturalWidth = decodedSize.width
        this.naturalHeight = decodedSize.height
        this.onload?.()
      })
    }
    decode(): Promise<void> {
      throw new Error('decode() must not be used: it can hang in a hidden window')
    }
  }
  vi.stubGlobal('Image', FakeImage)

  class FakeFileReader {
    result: string | null = null
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    readAsDataURL() {
      this.result = 'data:image/png;base64,ORIGINAL'
      this.onload?.()
    }
  }
  vi.stubGlobal('FileReader', FakeFileReader)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const file = (type: string, size = 1024, name = 'logo.png') =>
  ({ type, size, name }) as unknown as File

/** A canvas that records the size it was drawn at. */
function stubCanvas() {
  const drawn: { width: number; height: number }[] = []
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({
      drawImage: vi.fn((_i: unknown, _x: number, _y: number, width: number, height: number) =>
        drawn.push({ width, height }),
      ),
    })),
    toDataURL: vi.fn(() => 'data:image/png;base64,RESIZED'),
  }
  vi.spyOn(document, 'createElement').mockReturnValue(canvas as unknown as HTMLCanvasElement)
  return { canvas, drawn }
}

// An SVG is a document rather than a picture — it can carry scripts and fetch
// external references, and nothing here needs one.
test('offers raster formats only, never SVG', () => {
  expect(WATERMARK_FILE_ACCEPT).toContain('image/png')
  expect(WATERMARK_FILE_ACCEPT).toContain('image/jpeg')
  expect(WATERMARK_FILE_ACCEPT).not.toContain('svg')
})

test('refuses a file that is not a supported image', async () => {
  await expect(importWatermarkImage(file('image/svg+xml'))).rejects.toBeInstanceOf(
    WatermarkImageError,
  )
  await expect(importWatermarkImage(file('application/pdf'))).rejects.toThrow(/PNG, JPEG/)
})

// Rejected before any work is done on it, rather than after decoding a photo.
test('refuses a file too large to be a logo', async () => {
  await expect(
    importWatermarkImage(file('image/png', MAX_WATERMARK_FILE_BYTES + 1)),
  ).rejects.toThrow(/larger than/)
})

test('refuses something that cannot be decoded', async () => {
  decodeFails = true
  await expect(importWatermarkImage(file('image/png'))).rejects.toThrow(/not an image/)
})

test('refuses an image with no pixels', async () => {
  decodedSize = { width: 0, height: 0 }
  await expect(importWatermarkImage(file('image/png'))).rejects.toThrow(/empty/)
})

// A logo authored as a compact PNG must not be inflated by a needless round
// trip through the canvas.
test('keeps a small image byte-for-byte', async () => {
  const { drawn } = stubCanvas()
  const imported = await importWatermarkImage(file('image/png'))

  expect(imported.dataUrl).toBe('data:image/png;base64,ORIGINAL')
  expect(imported.name).toBe('logo.png')
  expect(imported).toMatchObject({ width: 64, height: 32 })
  expect(drawn).toEqual([])
})

test('downscales a large image to the stored bound, keeping its aspect', async () => {
  decodedSize = { width: 4096, height: 2048 }
  const { canvas, drawn } = stubCanvas()

  const imported = await importWatermarkImage(file('image/png'))

  expect(imported.dataUrl).toBe('data:image/png;base64,RESIZED')
  expect(imported.width).toBe(MAX_WATERMARK_STORED_EDGE)
  expect(imported.height).toBe(MAX_WATERMARK_STORED_EDGE / 2)
  expect(drawn).toEqual([
    { width: MAX_WATERMARK_STORED_EDGE, height: MAX_WATERMARK_STORED_EDGE / 2 },
  ])
  expect(canvas.width).toBe(MAX_WATERMARK_STORED_EDGE)
})

test('bounds the longest side whichever way the image is turned', async () => {
  decodedSize = { width: 500, height: 3000 }
  stubCanvas()
  const imported = await importWatermarkImage(file('image/png'))
  expect(imported.height).toBe(MAX_WATERMARK_STORED_EDGE)
  expect(Math.max(imported.width, imported.height)).toBe(MAX_WATERMARK_STORED_EDGE)
})

// A watermark is the one place transparency matters most: flattened onto white
// a logo would carry a white box across every export.
test('re-encodes to PNG so transparency survives the resize', async () => {
  decodedSize = { width: 2000, height: 2000 }
  const { canvas } = stubCanvas()
  await importWatermarkImage(file('image/jpeg', 1024, 'logo.jpg'))
  expect(canvas.toDataURL).toHaveBeenCalledWith('image/png')
})

/**
 * The regression this file's `FakeImage` exists to catch.
 *
 * `decode()` is the obvious call for "wait until this image is usable", and it
 * is the wrong one: it resolves off the rendering pipeline, so in a window that
 * is not painting it can never settle. Observed with an image that reported
 * `complete` and its true dimensions while the promise hung indefinitely —
 * which would have stranded any export started from a background tab.
 */
test('waits on load rather than decode, which can hang unwatched', async () => {
  const image = await loadImage('data:image/png;base64,AAAA')
  expect(image.naturalWidth).toBe(64)
  // The stub throws from `decode()`; reaching this line means nothing called it.
})

test('rejects an image that fails to load', async () => {
  decodeFails = true
  await expect(loadImage('data:image/png;base64,AAAA')).rejects.toBeInstanceOf(WatermarkImageError)
})
