import { afterEach, expect, test, vi } from 'vitest'

import { composeContactSheet, CONTACT_SHEET_WATERMARK } from './contactSheet'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test('draws three metadata rows at left and the Cairndex brand at right', async () => {
  const fillText = vi.fn()
  const drawImage = vi.fn()
  const context = {
    fillRect: vi.fn(),
    fillStyle: '',
    fillText,
    font: '',
    measureText: vi.fn(() => ({ width: 150 })),
    textAlign: 'left',
    textBaseline: 'alphabetic',
    drawImage,
  } as unknown as CanvasRenderingContext2D
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
    metadataRows: [
      { label: 'File Name', value: 'video.mp4' },
      { label: 'Details', value: '1.4 GB · 13:17 · 3840×2160 / 23.98 fps' },
      { label: 'Codec', value: 'H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz' },
    ],
    cols: 4,
    rows: 4,
  })

  expect(fillText.mock.calls.map(([text]) => text)).toEqual([
    ...CONTACT_SHEET_WATERMARK,
    'File Name: video.mp4',
    'Details: 1.4 GB · 13:17 · 3840×2160 / 23.98 fps',
    'Codec: H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz',
  ])
  expect(fillText.mock.calls[0]?.[1]).toBeGreaterThan(fillText.mock.calls[2]?.[1] as number)
  expect(drawImage).toHaveBeenCalledWith(grid, 0, expect.any(Number))
  expect(canvas.height).toBeGreaterThan(grid.height + 70)
  expect(canvas.height).toBeLessThan(grid.height + 120)
})
