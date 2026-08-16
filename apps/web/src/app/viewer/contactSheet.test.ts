import { afterEach, expect, test, vi } from 'vitest'

import { composeContactSheet, type ContactSheetSource } from './contactSheet'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const ROWS = [
  { label: 'File Name', value: 'video.mp4' },
  { label: 'Details', value: '1.4 GB · 13:17 · 3840×2160 / 23.98 fps' },
  { label: 'Codec', value: 'H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz' },
]

/** Compose a sheet against a recording canvas, returning what was drawn. */
async function compose(overrides: Partial<ContactSheetSource> = {}) {
  const drawn: { text: string; x: number; y: number; align: string }[] = []
  const drawImage = vi.fn()
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    fillRect: vi.fn(),
    fillStyle: '',
    font: '',
    measureText: vi.fn(() => ({ width: 150 })),
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: 'round',
    strokeText: vi.fn(),
    shadowBlur: 0,
    shadowOffsetY: 0,
    drawImage,
    fillText: vi.fn((text: string, x: number, y: number) =>
      drawn.push({ text, x, y, align: context.textAlign }),
    ),
  }
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['jpeg']))),
  } as unknown as HTMLCanvasElement
  const grid = { width: 1280, height: 720, close: vi.fn() }

  vi.spyOn(document, 'createElement').mockReturnValue(canvas)
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => grid),
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(new Uint8Array([1]))),
  )

  await composeContactSheet({
    sheetUrl: '/contact-sheet',
    metadataRows: ROWS,
    cols: 4,
    rows: 4,
    ...overrides,
  })
  return { drawn, canvas, grid, drawImage }
}

// The header used to carry a fixed "EXPORTED FROM / CAIRNDEX" block whether the
// owner wanted one or not; it is now the same opt-in mark the other exports use.
test('draws no mark when the owner has not asked for one', async () => {
  const { drawn } = await compose()
  expect(drawn.map(({ text }) => text)).toEqual([
    'File Name: video.mp4',
    'Details: 1.4 GB · 13:17 · 3840×2160 / 23.98 fps',
    'Codec: H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz',
  ])
})

test('draws the mark at the header’s top right, above the metadata rows', async () => {
  const { drawn } = await compose({ watermark: { kind: 'text', text: 'STUDIO ALPHA' } })
  expect(drawn.map(({ text }) => text)).toEqual([
    'STUDIO ALPHA',
    'File Name: video.mp4',
    'Details: 1.4 GB · 13:17 · 3840×2160 / 23.98 fps',
    'Codec: H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz',
  ])
  const [mark, firstRow] = drawn
  // Positioned rather than merely right-aligned: the mark's origin is computed
  // from its measured size, which is what lets a picture land in the same spot.
  expect(mark?.x).toBeGreaterThan(1280 / 2)
  expect(firstRow?.align).toBe('left')
  expect(firstRow?.x).toBeLessThan(1280 / 2)
  // Clear of the rows it shares the band with.
  expect(mark?.x).toBeGreaterThan(firstRow?.x ?? 0)
})

// The mark sits in the header band, which is above the grid — never over a frame.
test('keeps the mark inside the header, off the frames', async () => {
  const { drawn, grid, drawImage } = await compose({
    watermark: { kind: 'text', text: 'STUDIO ALPHA' },
  })
  const headerHeight = drawImage.mock.calls[0]?.[2] as number
  expect(drawImage).toHaveBeenCalledWith(grid, 0, expect.any(Number))
  expect(drawn[0]?.y).toBeLessThan(headerHeight)
  expect(drawn[0]?.y).toBeGreaterThan(0)
})

// Retiring the fixed block must not change the band's height — the sheet's
// proportions come from its three metadata rows, not from what is beside them.
test('leaves the header height to the metadata rows', async () => {
  const withMark = await compose({ watermark: { kind: 'text', text: 'STUDIO ALPHA' } })
  const without = await compose()
  expect(withMark.canvas.height).toBe(without.canvas.height)
  expect(without.canvas.height).toBeGreaterThan(without.grid.height + 70)
  expect(without.canvas.height).toBeLessThan(without.grid.height + 120)
})

// The header has a padding its metadata rows observe. The mark used to derive
// a larger inset from its own size and so began lower than the text beside it,
// which the owner saw as the mark sitting too low (2026-08-16).
test('starts the mark level with the first metadata row, not below it', async () => {
  const { drawn } = await compose({ watermark: { kind: 'text', text: 'STUDIO ALPHA' } })
  const [mark, firstRow] = drawn
  // Both are drawn from the header's own padding, so they share a top edge.
  expect(mark?.y).toBeLessThanOrEqual(firstRow?.y ?? 0)
})
