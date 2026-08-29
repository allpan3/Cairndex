import { expect, test } from 'vitest'

import type { DirectoryMember, FileRead } from '../api/client'
import { bundleRows, isInside, memberCovering, playlistFor, proposalEntries } from './bundleRows'

function file(path: string, overrides: Partial<FileRead> = {}): FileRead {
  return {
    id: path,
    bundle_id: 'b1',
    relative_path: path,
    original_filename: path.split('/').pop() ?? path,
    display_title: path.split('/').pop() ?? path,
    role: 'image',
    media_kind: 'image',
    mime_type: 'image/jpeg',
    sequence: 0,
    size_bytes: 1,
    availability: 'available',
    quick_fingerprint: null,
    cover_time: null,
    resume_position: null,
    supported: true,
    tech_metadata: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
    ...overrides,
  }
}

function member(directory: string, overrides: Partial<DirectoryMember> = {}): DirectoryMember {
  return {
    id: `m:${directory}`,
    bundle_id: 'b1',
    directory_path: directory,
    name: directory.split('/').pop() ?? directory,
    sequence: 0,
    file_count: 0,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

test('a folder covers its own directory and everything beneath it', () => {
  const album = member('album')
  expect(isInside(file('album/shot.jpg'), album)).toBe(true)
  expect(isInside(file('album/raw/shot.dng'), album)).toBe(true)
})

test('a sibling sharing a name prefix is not inside', () => {
  // The trailing slash is the whole guard: without it `album2` reads as inside
  // `album`, and a neighbouring folder's files vanish from the bundle.
  expect(isInside(file('album2/shot.jpg'), member('album'))).toBe(false)
  expect(isInside(file('albumfoo.jpg'), member('album'))).toBe(false)
})

test('the folder itself is not one of its own files', () => {
  expect(memberCovering(file('album'), [member('album')])).toBeNull()
})

test('rows interleave folders and loose files by their shared sequence', () => {
  const rows = bundleRows(
    [
      file('poster.jpg', { id: 'f-poster', sequence: 0 }),
      file('album/a.jpg', { id: 'f-a', sequence: 1 }),
      file('album/b.jpg', { id: 'f-b', sequence: 2 }),
      file('notes.txt', { id: 'f-notes', sequence: 3 }),
    ],
    [member('album', { id: 'm-album', sequence: 1 })],
  )
  expect(rows.map((row) => row.id)).toEqual(['f-poster', 'm-album', 'f-notes'])
  expect(rows.map((row) => row.kind)).toEqual(['file', 'folder', 'file'])
})

test('a folder and a file on the same sequence break the tie by id, as the server does', () => {
  const rows = bundleRows(
    [file('a.jpg', { id: 'aaa', sequence: 5 })],
    [member('album', { id: 'zzz', sequence: 5 })],
  )
  expect(rows.map((row) => row.id)).toEqual(['aaa', 'zzz'])
  const flipped = bundleRows(
    [file('a.jpg', { id: 'zzz', sequence: 5 })],
    [member('album', { id: 'aaa', sequence: 5 })],
  )
  expect(flipped.map((row) => row.id)).toEqual(['aaa', 'zzz'])
})

test('with no folder members the rows are just the files', () => {
  const files = [file('a.jpg', { sequence: 0 }), file('b.jpg', { sequence: 1 })]
  expect(bundleRows(files, []).map((row) => row.id)).toEqual(['a.jpg', 'b.jpg'])
})

test('playing the bundle skips what a folder covers', () => {
  const files = [file('trailer.mp4', { media_kind: 'video' }), file('album/a.jpg')]
  expect(playlistFor(files, [member('album')]).map((f) => f.relative_path)).toEqual(['trailer.mp4'])
})

test('opening a file inside a folder pages through that folder instead', () => {
  // Filtering it out here too would strand the viewer on a file its own
  // playlist says does not exist — no next, no previous, nothing to show.
  const files = [
    file('trailer.mp4', { id: 'trailer', media_kind: 'video' }),
    file('album/a.jpg', { id: 'a' }),
    file('album/b.jpg', { id: 'b' }),
    file('other/c.jpg', { id: 'c' }),
  ]
  const members = [member('album'), member('other')]
  expect(playlistFor(files, members, 'a').map((f) => f.id)).toEqual(['a', 'b'])
  expect(playlistFor(files, members, 'c').map((f) => f.id)).toEqual(['c'])
})

test('opening a loose file still skips every folder', () => {
  const files = [file('trailer.mp4', { id: 'trailer', media_kind: 'video' }), file('album/a.jpg')]
  expect(playlistFor(files, [member('album')], 'trailer').map((f) => f.id)).toEqual(['trailer'])
})

test('unplayable files never reach the playlist, folder or not', () => {
  const files = [
    file('notes.txt', { id: 'notes', media_kind: 'other', supported: false }),
    file('album/a.jpg', { id: 'a' }),
  ]
  expect(playlistFor(files, [member('album')], 'notes')).toEqual([])
})

function pfile(path: string, sequence: number) {
  return { asset_file_id: path, relative_path: path, sequence }
}

const DIR = { id: 'd1', directory_path: 'trip/album' }

test('a folder is anchored where its files begin, not after them', () => {
  // Appending folders after the loose files stranded a listed folder at the
  // very bottom, an apparently empty row nowhere near what it belonged to.
  const entries = proposalEntries(
    [
      pfile('trip/clip.mp4', 0),
      pfile('trip/album/a.jpg', 1),
      pfile('trip/album/b.jpg', 2),
      pfile('trip/notes.png', 3),
    ],
    [DIR],
    (f) => f.asset_file_id,
  )
  expect(entries.map((e) => e.key)).toEqual(['trip/clip.mp4', 'd1', 'trip/notes.png'])
  const folder = entries.find((e) => e.kind === 'folder')
  expect(folder?.kind === 'folder' && folder.contents.map((f) => f.relative_path)).toEqual([
    'trip/album/a.jpg',
    'trip/album/b.jpg',
  ])
})

test('a folder leads the files it covers rather than sitting among them', () => {
  // Same position, so the tie-break decides: a folder row is a header over its
  // files, never a peer of the first one.
  const entries = proposalEntries(
    [pfile('trip/album/a.jpg', 0), pfile('trip/clip.mp4', 1)],
    [DIR],
    (f) => f.asset_file_id,
  )
  expect(entries.map((e) => e.key)).toEqual(['d1', 'trip/clip.mp4'])
})

test('a file index stays its position in the original list', () => {
  // A drop target means "index in the proposal's files", which the visible
  // position stops matching the moment a folder hides or reorders anything.
  const entries = proposalEntries(
    [pfile('trip/album/a.jpg', 0), pfile('trip/album/b.jpg', 1), pfile('trip/tail.png', 2)],
    [DIR],
    (f) => f.asset_file_id,
  )
  const tail = entries.find((e) => e.key === 'trip/tail.png')
  expect(tail?.index).toBe(2)
})

test('a folder matching none of the files is not drawn at all', () => {
  const entries = proposalEntries([pfile('other/x.jpg', 0)], [DIR], (f) => f.asset_file_id)
  expect(entries.map((e) => e.key)).toEqual(['other/x.jpg'])
})
