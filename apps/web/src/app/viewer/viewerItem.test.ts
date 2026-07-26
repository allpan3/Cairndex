import { afterEach, expect, test } from 'vitest'

import type { FileBrowserEntry, FileRead } from '../../api/client'
import { setActiveLibraryId } from '../../api/client'
import { viewerItemFromEntry, viewerItemFromFile } from './viewerItem'

setActiveLibraryId('lib1')

afterEach(() => setActiveLibraryId('lib1'))

function file(overrides: Partial<FileRead> = {}): FileRead {
  return {
    id: 'f1',
    bundle_id: 'b1',
    relative_path: 'photo.png',
    original_filename: 'photo.png',
    display_title: 'Photo',
    role: 'image',
    media_kind: 'image',
    mime_type: 'image/png',
    sequence: 0,
    size_bytes: 123,
    availability: 'available',
    quick_fingerprint: '123:456',
    cover_time: null,
    supported: true,
    tech_metadata: { width: 1600, height: 1000 },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  }
}

function entry(overrides: Partial<FileBrowserEntry> = {}): FileBrowserEntry {
  return {
    name: 'clip.mp4',
    relative_path: 'Show/clip.mp4',
    kind: 'file',
    size_bytes: 2048,
    modified_at: '2026-06-25T00:00:00Z',
    created_at: '2026-06-25T00:00:00Z',
    extension: 'mp4',
    mime_type: 'video/mp4',
    media_kind: 'video',
    supported: true,
    linked: false,
    bundle_id: null,
    file_id: null,
    container: null,
    video_codec: null,
    audio_codec: null,
    duration: null,
    resume_position: null,
    unbundled: false,
    ...overrides,
  }
}

test('a bundle file keeps its row identity and cover affordance', () => {
  const item = viewerItemFromFile(file({ cover_time: 12 }))

  expect(item.key).toBe('f1')
  expect(item.fileId).toBe('f1')
  expect(item.bundleId).toBe('b1')
  expect(item.canSetCover).toBe(true)
  expect(item.coverTime).toBe(12)
  expect(item.width).toBe(1600)
  expect(item.height).toBe(1000)
  // Its image tiers start at the cover thumbnail it already has.
  expect(item.imageTiers[0]?.tier).toBe('thumbnail')
  expect(item.imageTiers.at(-1)?.tier).toBe('original')
})

test('an unindexed path has no row, so nothing keyed on one applies', () => {
  const item = viewerItemFromEntry(entry())

  expect(item.key).toBe('Show/clip.mp4')
  expect(item.fileId).toBeNull()
  expect(item.bundleId).toBeNull()
  // A cover belongs to a bundle; this path has none to set.
  expect(item.canSetCover).toBe(false)
  expect(item.coverTime).toBeNull()
  // Playback reads the path itself rather than a file-id stream endpoint.
  expect(item.contentUrl).toContain('/file?path=Show%2Fclip.mp4')
})

test('a linked path streams through its file row', () => {
  const item = viewerItemFromEntry(
    entry({ linked: true, file_id: 'f9', bundle_id: 'b9', duration: 42 }),
  )

  expect(item.fileId).toBe('f9')
  expect(item.bundleId).toBe('b9')
  expect(item.duration).toBe(42)
  expect(item.contentUrl).toContain('/files/f9/stream')
  // Identity for the playlist is still the path — that is what the folder listed.
  expect(item.key).toBe('Show/clip.mp4')
})

test('File Browser image tiers skip the thumbnail rank', () => {
  const nonNative = viewerItemFromEntry(
    entry({ name: 'scan.tiff', relative_path: 'scan.tiff', media_kind: 'image' }),
  )
  expect(nonNative.imageTiers.map((tier) => tier.tier)).toEqual(['preview1600', 'preview2560'])
  expect(nonNative.imageTiers[0]?.src).toContain('/file/preview?path=scan.tiff')

  const native = viewerItemFromEntry(
    entry({ name: 'art.jpg', relative_path: 'art.jpg', media_kind: 'image' }),
  )
  expect(native.imageTiers.map((tier) => tier.tier)).toEqual(['original'])
  expect(native.imageTiers[0]?.src).toContain('/file?path=art.jpg')
})

test('an unclassified path falls back to its extension for a type label', () => {
  const item = viewerItemFromEntry(
    entry({ name: 'notes.xyz', relative_path: 'notes.xyz', media_kind: null, supported: false }),
  )

  expect(item.mediaKind).toBeNull()
  expect(item.typeLabel).toBe('xyz')
  expect(item.imageTiers).toEqual([])
})
