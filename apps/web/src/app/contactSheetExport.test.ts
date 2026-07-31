import { expect, test } from 'vitest'

import { CONTACT_SHEET_WIDTHS, contactSheetRows } from './contactSheetExport'
import { CONTACT_SHEET_WATERMARK } from './viewer/contactSheet'

test('offers the three higher-resolution contact-sheet widths', () => {
  expect(CONTACT_SHEET_WIDTHS).toEqual([1600, 2048, 2560])
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
