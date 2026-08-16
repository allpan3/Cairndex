import { expect, test } from 'vitest'

import {
  CONTACT_SHEET_GRIDS,
  CONTACT_SHEET_WIDTHS,
  DEFAULT_CONTACT_SHEET_GRID,
  DEFAULT_CONTACT_SHEET_WIDTH,
  contactSheetRows,
} from './contactSheetExport'
import { setActiveLibraryId } from '../api/client'
import { CONTACT_SHEET_WATERMARK } from './viewer/contactSheet'
import { viewerItemFromEntry } from './viewer/viewerItem'

// viewerItemFromEntry builds a stream URL for a linked row, which is scoped.
setActiveLibraryId('lib1')

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

// 4×4 is the floor — below it a sheet stops being a sheet — and 8×8 the top,
// which costs 3.6s against 4×4's 1.0s on a real file (owner, 2026-08-15).
test('offers square grids from 4×4 to 8×8, defaulting to 5×5', () => {
  expect(CONTACT_SHEET_GRIDS).toEqual([4, 5, 6, 7, 8])
  expect(DEFAULT_CONTACT_SHEET_GRID).toBe(5)
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

test('a sheet cut from a File Browser row prints its real dimensions', () => {
  // The same file, opened from the physical browsing surface rather than the
  // logical one, used to lose both numbers on the way: the listing did not
  // carry them, so the header read "— / —" (owner-reported, 2026-08-15).
  const item = viewerItemFromEntry({
    name: 'clip.mp4',
    relative_path: 'Set07/clip.mp4',
    kind: 'file',
    size_bytes: 1_500_000_000,
    modified_at: null,
    created_at: null,
    extension: 'mp4',
    mime_type: 'video/mp4',
    media_kind: 'video',
    supported: true,
    linked: true,
    bundle_id: 'b1',
    file_id: 'f1',
    container: 'mov,mp4',
    video_codec: 'h264',
    video_codec_tag: 'avc1',
    audio_codec: 'aac',
    duration: 797,
    width: 3840,
    height: 2160,
    fps: 23.976,
    resume_position: null,
    unbundled: false,
  })

  const rows = contactSheetRows({
    fileId: item.fileId ?? '',
    title: item.title,
    sizeBytes: item.sizeBytes,
    duration: item.duration,
    width: item.width,
    height: item.height,
    fps: item.fps,
  })

  expect(rows[1]).toEqual({
    label: 'Details',
    value: '1.4 GB · 13:17 · 3840×2160 / 23.98 fps',
  })
})
