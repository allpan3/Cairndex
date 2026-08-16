import { expect, test } from 'vitest'

import type { FileBrowserEntry, FileRead } from '../api/client'
import { factsFromEntry, inspectorTargetForBundleFile, inspectorTargetForEntry } from './fileFacts'

function entry(overrides: Partial<FileBrowserEntry> = {}): FileBrowserEntry {
  return {
    name: 'clip1.mp4',
    relative_path: 'Set07/clip1.mp4',
    kind: 'file',
    size_bytes: 2048,
    modified_at: '2026-08-16T00:00:00Z',
    created_at: '2026-08-16T00:00:00Z',
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
    duration: 42,
    resume_position: null,
    unbundled: false,
    ...overrides,
  }
}

function bundleFile(overrides: Partial<FileRead> = {}): FileRead {
  return {
    id: 'f1',
    bundle_id: 'b1',
    relative_path: 'Set07/clip1.mp4',
    original_filename: 'clip1.mp4',
    display_title: 'clip1.mp4',
    role: 'primary_video',
    media_kind: 'video',
    mime_type: 'video/mp4',
    sequence: 0,
    size_bytes: 2048,
    availability: 'available',
    quick_fingerprint: '1:2',
    cover_time: null,
    supported: true,
    tech_metadata: { width: 1920, height: 1080 },
    created_at: '2026-08-16T00:00:00Z',
    updated_at: '2026-08-16T00:00:00Z',
    version: 1,
    ...overrides,
  } as FileRead
}

// The reported bug: a scan stages every new file into a provisional one-file
// bundle, so "has a bundle_id" is not the same question as "is in a bundle".
test('an unbundled file gets the file pane, not the bundle it is staged in', () => {
  const target = inspectorTargetForEntry(entry({ unbundled: true }))

  expect(target?.kind).toBe('file')
})

test('a file in a confirmed bundle still gets the bundle pane', () => {
  expect(inspectorTargetForEntry(entry())).toEqual({ kind: 'bundle', bundleId: 'b1' })
})

test('a path that was never indexed gets the file pane too', () => {
  const target = inspectorTargetForEntry(entry({ linked: false, bundle_id: null, file_id: null }))

  expect(target?.kind).toBe('file')
  if (target?.kind === 'file') expect(target.facts.status).toBe('Not indexed')
})

test('nothing selected means nothing to inspect', () => {
  expect(inspectorTargetForEntry(null)).toBeNull()
})

test('a provisional bundle opened from Missing Files describes its file', () => {
  // Bundle Browser views exclude provisional bundles; Missing Files does not.
  const target = inspectorTargetForBundleFile('b1', 'provisional', bundleFile())

  expect(target?.kind).toBe('file')
})

test('a confirmed bundle opened from the Bundle Browser describes the bundle', () => {
  expect(inspectorTargetForBundleFile('b1', 'confirmed', bundleFile())).toEqual({
    kind: 'bundle',
    bundleId: 'b1',
  })
})

test('a File Browser row carries the dimensions and frame rate it now has', () => {
  // The listing used to stop at codecs and duration, so the file inspector read
  // "—" for a file whose numbers the server already knew.
  const facts = factsFromEntry(entry({ width: 3840, height: 2160, fps: 23.976, bit_depth: 10 }))

  expect(facts.width).toBe(3840)
  expect(facts.height).toBe(2160)
  expect(facts.fps).toBe(23.976)
  expect(facts.bitDepth).toBe(10)
})
