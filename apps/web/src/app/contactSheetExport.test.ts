import { expect, test } from 'vitest'

import {
  CONTACT_SHEET_GRIDS,
  CONTACT_SHEET_WIDTHS,
  DEFAULT_CONTACT_SHEET_GRID,
  DEFAULT_CONTACT_SHEET_WIDTH,
  contactSheetRows,
} from './contactSheetExport'
import { CONTACT_SHEET_WATERMARK } from './viewer/contactSheet'

// Both ladders grew when the dialog moved from segmented rows onto wheels
// (owner, 2026-08-15) — a row had to fit every option side by side.
test('offers a full ladder of sheet widths, inside the server bound', () => {
  expect(CONTACT_SHEET_WIDTHS.length).toBeGreaterThan(3)
  expect(Math.min(...CONTACT_SHEET_WIDTHS)).toBeGreaterThanOrEqual(800)
  expect(Math.max(...CONTACT_SHEET_WIDTHS)).toBeLessThanOrEqual(6144)
  expect(CONTACT_SHEET_WIDTHS).toContain(DEFAULT_CONTACT_SHEET_WIDTH)
  // Ascending, so the wheel reads left to right as smaller to larger.
  expect([...CONTACT_SHEET_WIDTHS]).toEqual([...CONTACT_SHEET_WIDTHS].sort((a, b) => a - b))
})

test('offers every square grid the server accepts', () => {
  expect(CONTACT_SHEET_GRIDS).toEqual([2, 3, 4, 5, 6])
  expect(CONTACT_SHEET_GRIDS).toContain(DEFAULT_CONTACT_SHEET_GRID)
})

test('builds all three contact-sheet header rows from available metadata', () => {
  expect(
    contactSheetRows({
      fileId: 'file-one',
      title: 'video.mp4',
      sizeBytes: 1_500_000_000,
      duration: 797,
      width: 3840,
      height: 2160,
      fps: 23.976,
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoBitrate: 14_002_584,
      audioBitrate: 192_002,
      audioSampleRate: 48_000,
    }),
  ).toEqual([
    { label: 'File Name', value: 'video.mp4' },
    { label: 'Details', value: '1.4 GB · 13:17 · 3840×2160 / 23.98 fps' },
    { label: 'Codec', value: 'H.264 / 14.0 Mbps · AAC / 192 kbps / 48 kHz' },
  ])
})

test('keeps every header row when metadata is unavailable', () => {
  expect(
    contactSheetRows({
      fileId: 'file-one',
      title: '',
    }),
  ).toEqual([
    { label: 'File Name', value: '—' },
    { label: 'Details', value: '— · — · — / —' },
    { label: 'Codec', value: '— · —' },
  ])
})

test('brands the exported header without changing its metadata rows', () => {
  expect(CONTACT_SHEET_WATERMARK).toEqual(['EXPORTED FROM', 'CAIRNDEX'])
})
