/**
 * A folder member drawn in the inspector rail (plan 6 S2).
 *
 * The behaviour worth pinning is that a folder row *replaces* the files it
 * covers rather than joining them — the whole point is that an album of a
 * thousand photos does not fill the rail — and that the operation stays
 * reversible from the row it creates.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { DirectoryMember, FileRead } from '../api/client'
import { FileList } from './Inspector'

const hooks = vi.hoisted(() => ({
  files: [] as unknown[],
  members: [] as unknown[],
  reorder: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  update: { mutate: vi.fn(), error: null },
  collapse: { mutate: vi.fn() },
  expand: { mutate: vi.fn() },
}))

vi.mock('../api/hooks', () => ({
  useBundle: vi.fn(),
  useBundleFiles: () => ({ data: hooks.files }),
  useBundleDirectoryMembers: () => ({ data: hooks.members }),
  useDirectoryMemberMutations: () => ({ collapse: hooks.collapse, expand: hooks.expand }),
  useFileMutations: () => ({ reorder: hooks.reorder, remove: hooks.remove }),
  useForgetMissingFiles: () => ({ mutate: vi.fn() }),
  useFileRepairCandidate: vi.fn(),
  useRepairFile: vi.fn(),
  useUpdateBundle: () => hooks.update,
}))

function file(id: string, path: string, sequence: number): FileRead {
  return {
    id,
    bundle_id: 'bundle',
    relative_path: path,
    original_filename: path.split('/').pop(),
    display_title: path.split('/').pop(),
    role: 'image',
    media_kind: 'image',
    mime_type: 'image/jpeg',
    sequence,
    size_bytes: 1_000,
    availability: 'available',
    supported: true,
    tech_metadata: {},
    created_at: '2026-07-21T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
  } as FileRead
}

function member(directory: string, sequence: number, fileCount: number): DirectoryMember {
  return {
    id: `m-${directory}`,
    bundle_id: 'bundle',
    directory_path: directory,
    name: directory.split('/').pop() ?? directory,
    sequence,
    file_count: fileCount,
    created_at: '2026-07-21T00:00:00Z',
  } as DirectoryMember
}

beforeEach(() => {
  hooks.files = [
    file('poster', 'poster.jpg', 0),
    file('a', 'album/a.jpg', 1),
    file('b', 'album/b.jpg', 2),
  ]
  hooks.members = [member('album', 1, 2)]
  hooks.collapse.mutate.mockReset()
  hooks.expand.mutate.mockReset()
  hooks.reorder.mutate.mockReset()
})

test('one folder row replaces every file it covers, in their place', () => {
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  const rows = screen.getAllByRole('listitem')
  expect(rows).toHaveLength(2)
  expect(rows[1]).toHaveAttribute('aria-label', 'Folder album, 2 files')
  expect(screen.queryByTitle('a.jpg')).not.toBeInTheDocument()
  expect(screen.getByTitle('poster.jpg')).toBeInTheDocument()
})

test('the heading still counts every file the bundle holds, and says how many folders', () => {
  // The rail draws two rows but the bundle really does hold three files;
  // reporting the row count instead would quietly understate the bundle.
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getByText(/Files in bundle \(3 · 1 folder\)/)).toBeInTheDocument()
})

test('a folder carries no cover star and no play button', () => {
  // A folder is a container, not a work — both were dropped from the design.
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} onPlayFile={vi.fn()} />)
  const folderRow = screen.getAllByRole('listitem')[1]
  expect(folderRow?.querySelector('.cover-action')).toBeNull()
  expect(folderRow?.querySelector('.play-file-action')).toBeNull()
})

test('the folder row expands back into the bundle from its own menu', () => {
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  fireEvent.contextMenu(screen.getAllByRole('listitem')[1] as Element)
  fireEvent.click(screen.getByText('Expand “album” into the Bundle'))
  expect(hooks.expand.mutate).toHaveBeenCalledWith('m-album')
})

test('opening a folder hands off to the File Browser rather than the viewer', () => {
  // Opening a folder navigates *into* it. `onLocateFile` lands in the parent
  // and highlights the entry, which for a folder shows everything except what
  // is inside it — so the row takes the distinct action instead.
  const onOpenFolderInBrowser = vi.fn()
  render(
    <FileList
      bundleId="bundle"
      bundleVersion={1}
      coverId={null}
      onOpenFolderInBrowser={onOpenFolderInBrowser}
    />,
  )
  const folderRow = screen.getAllByRole('listitem')[1] as Element
  fireEvent.doubleClick(folderRow)
  expect(onOpenFolderInBrowser).toHaveBeenCalledWith('album')

  onOpenFolderInBrowser.mockReset()
  fireEvent.keyDown(folderRow, { key: 'Enter' })
  expect(onOpenFolderInBrowser).toHaveBeenCalledWith('album')
})

test('a file row offers to collapse its own directory', () => {
  hooks.members = []
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  // Row 1 is `album/a.jpg` now that nothing is collapsed.
  fireEvent.contextMenu(screen.getAllByRole('listitem')[1] as Element)
  fireEvent.click(screen.getByText('Collapse “album” into One Row'))
  expect(hooks.collapse.mutate).toHaveBeenCalledWith('album')
})

test('a file at the library root has no directory to collapse', () => {
  hooks.members = []
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  fireEvent.contextMenu(screen.getAllByRole('listitem')[0] as Element)
  expect(screen.queryByText(/Collapse/)).not.toBeInTheDocument()
})

test('keyboard reorder steps between visible rows, not into hidden files', () => {
  // Indexing into the raw file list would step onto `album/a.jpg`, which the
  // rail is not drawing — the key press would look dead while moving something
  // out of sight.
  hooks.files = [
    file('poster', 'poster.jpg', 0),
    file('a', 'album/a.jpg', 1),
    file('notes', 'notes.png', 2),
  ]
  hooks.members = [member('album', 1, 1)]
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  const rows = screen.getAllByRole('listitem')
  // Rows are poster, album (folder), notes — so notes' visible neighbour up is
  // poster, and the reorder must be expressed over the full membership.
  fireEvent.keyDown(rows[2] as Element, { key: 'ArrowUp', altKey: true })
  expect(hooks.reorder.mutate).toHaveBeenCalledWith(['notes', 'poster', 'a'])
})
