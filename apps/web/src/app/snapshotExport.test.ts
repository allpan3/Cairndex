import { act, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { resetExportPrefsForTests, useExportPrefs } from '../state/exportPrefs'
import {
  defaultSnapshotWidth,
  saveSnapshot,
  snapshotFileName,
  snapshotHeight,
  snapshotWidthOptions,
} from './snapshotExport'
import { watermarkFontSize, watermarkMargin } from './watermark'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetExportPrefsForTests()
})

const widths = (source: number) =>
  snapshotWidthOptions(source).map((option) => `${option.label}:${option.value}`)

test('ends the ladder at the source’s own width', () => {
  expect(widths(1920)).toEqual([
    '320px:320',
    '480px:480',
    '640px:640',
    '854px:854',
    '960px:960',
    '1280px:1280',
    '1600px:1600',
    '1920px:1920',
  ])
  expect(snapshotWidthOptions(1920).at(-1)?.note).toBe('native')
})

// Scaling a still up adds nothing, so nothing above the source is offered.
test('drops rungs the source cannot fill', () => {
  expect(widths(720)).toEqual(['320px:320', '480px:480', '640px:640', '720px:720'])
  expect(widths(400)).toEqual(['320px:320', '400px:400'])
})

// Unlike the GIF, a snapshot is a canvas draw rather than an encode, so a 4K
// source keeps its own size at the top of the wheel.
test('a source above every rung is still offered whole', () => {
  expect(widths(3840).at(-1)).toBe('3840px:3840')
  expect(widths(5000).at(-1)).toBe('5000px:5000')
})

test('a source below every rung offers only itself', () => {
  expect(widths(200)).toEqual(['200px:200'])
})

// One rung below native: smaller than the original without being tiny.
test('defaults to the rung below native', () => {
  expect(defaultSnapshotWidth(snapshotWidthOptions(1920))).toBe(1600)
  expect(defaultSnapshotWidth(snapshotWidthOptions(720))).toBe(640)
  // With only its own width on offer there is nowhere else to go.
  expect(defaultSnapshotWidth(snapshotWidthOptions(200))).toBe(200)
})

test('keeps the source aspect when scaling', () => {
  expect(snapshotHeight(960, 1920, 1080)).toBe(540)
  expect(snapshotHeight(640, 1920, 1080)).toBe(360)
  expect(snapshotHeight(400, 640, 480)).toBe(300)
  // Unlike the GIF path there is no even-height rule — a PNG has no such
  // constraint, so the exact aspect is kept.
  expect(snapshotHeight(321, 1920, 1080)).toBe(181)
})

test('has no height for an unprobed source', () => {
  expect(snapshotHeight(480, 0, 0)).toBe(0)
})

/**
 * Save one snapshot against a recording canvas.
 *
 * `createElement` is tag-aware because the browser download path asks for an
 * `<a>` from the same document the canvas came from.
 */
async function saveAgainstFakeCanvas(width?: number) {
  const drawn: { text: string; x: number; y: number; align: string }[] = []
  const context = {
    save: vi.fn(),
    restore: vi.fn(),
    drawImage: vi.fn(),
    measureText: vi.fn(() => ({ width: 120 })),
    fillRect: vi.fn(),
    fillText: vi.fn((text: string, x: number, y: number) =>
      drawn.push({ text, x, y, align: context.textAlign }),
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
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => context),
    toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['png']))),
  } as unknown as HTMLCanvasElement
  const anchor = { href: '', download: '', click: vi.fn() }

  vi.spyOn(document, 'createElement').mockImplementation(
    (tag: string) => (tag === 'canvas' ? canvas : anchor) as unknown as HTMLElement,
  )
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() })

  const video = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement
  // Awaited: the capture resolves the mark first, so a picture watermark has
  // decoded before anything is drawn.
  await saveSnapshot(video, 'clip.mp4', width === undefined ? {} : { width })
  return { drawn, canvas }
}

test('stamps nothing on a snapshot while the mark is off', async () => {
  const { drawn } = await saveAgainstFakeCanvas()
  expect(drawn).toEqual([])
})

test('stamps the mark bottom-right of the snapshot', async () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkEnabled: true, watermarkText: 'STUDIO' }))

  const { drawn, canvas } = await saveAgainstFakeCanvas()

  expect(drawn.map(({ text }) => text)).toEqual(['STUDIO'])
  expect(drawn[0]?.x).toBeGreaterThan(canvas.width / 2)
  expect(drawn[0]?.y).toBeGreaterThan(canvas.height / 2)
})

// Sized against the output, not the source: a 4K frame saved at 640px gets a
// mark to match rather than one shrunk from the resolution it was cut from.
test('sizes the mark against the scaled-down output', async () => {
  const { result } = renderHook(() => useExportPrefs())
  act(() => result.current[1]({ watermarkEnabled: true, watermarkText: 'STUDIO' }))

  const { drawn, canvas } = await saveAgainstFakeCanvas(640)

  expect(canvas.width).toBe(640)
  // The whole mark and its inset together come to less than a single cap
  // height at 1920 — which only holds if it was sized for the 640px output
  // rather than for the source it was cut from.
  const fromBottom = canvas.height - (drawn[0]?.y ?? 0)
  expect(fromBottom).toBeLessThan(watermarkFontSize(1920))
  expect(fromBottom).toBeGreaterThan(watermarkMargin(watermarkFontSize(640)))
})

// The old name mangled the extension into the stem, giving `clip_mp4.png`.
test('names the PNG after the source without doubling its extension', () => {
  expect(snapshotFileName('clip.mp4')).toBe('clip.png')
  expect(snapshotFileName('a movie.mkv')).toBe('a movie.png')
  expect(snapshotFileName('Scene 2.5 rework')).toBe('Scene 2.5 rework.png')
  expect(snapshotFileName('a/b:c*d?.mkv')).toBe('a b c d.png')
  expect(snapshotFileName('')).toBe('snapshot.png')
})
