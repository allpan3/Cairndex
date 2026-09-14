import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { basisOf, rememberBasis } from '../api/editBasis'
import { FileList } from './Inspector'

const hooks = vi.hoisted(() => ({
  files: [] as unknown[] | undefined,
  members: [] as unknown[] | undefined,
  error: null as Error | null,
  memberError: null as Error | null,
  fetching: false,
  refetch: vi.fn(),
  refetchMembers: vi.fn(),
  reorder: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  update: { mutate: vi.fn(), error: null },
}))

vi.mock('../api/hooks', () => ({
  useBundle: vi.fn(),
  useBundleFiles: () => ({
    data: hooks.files,
    error: hooks.error,
    isFetching: hooks.fetching,
    refetch: hooks.refetch,
  }),
  // Plan 6 folder rows: absent in these fixtures, so the rail draws every file
  // exactly as it did before folder members existed.
  useBundleDirectoryMembers: () => ({
    data: hooks.members,
    error: hooks.memberError,
    refetch: hooks.refetchMembers,
  }),
  useDirectoryMemberMutations: () => ({
    collapse: { mutate: vi.fn() },
    expand: { mutate: vi.fn() },
  }),
  useFileMutations: () => ({ reorder: hooks.reorder, remove: hooks.remove }),
  useForgetMissingFiles: () => ({ mutate: vi.fn() }),
  useFileRepairCandidate: vi.fn(),
  useRepairFile: vi.fn(),
  useUpdateBundle: () => hooks.update,
}))

/** Minimal available file used by the inspector row interaction tests. */
function file(id: string, displayTitle: string, sequence: number): FileRead {
  return {
    id,
    bundle_id: 'bundle',
    relative_path: `folder/${displayTitle}`,
    original_filename: displayTitle,
    display_title: displayTitle,
    role: 'primary_video',
    media_kind: 'video',
    mime_type: 'video/mp4',
    sequence,
    size_bytes: 1_000,
    availability: 'available',
    supported: true,
    tech_metadata: {},
    created_at: '2026-07-21T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
  } as FileRead
}

beforeEach(() => {
  hooks.members = []
  hooks.error = null
  hooks.memberError = null
  hooks.fetching = false
  hooks.refetch.mockReset()
  hooks.refetchMembers.mockReset()
  hooks.files = [file('first', 'first.mp4', 0), file('second', 'second.mp4', 1)]
  hooks.reorder.mutate.mockReset()
  hooks.remove.mutate.mockReset()
  hooks.update.mutate.mockReset()
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(),
  })
})

test('pending files never claim an empty bundle and pending folders do not expose loose files', () => {
  hooks.files = undefined
  const view = render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getByRole('status')).toHaveTextContent('Loading bundle files…')
  expect(screen.queryByText(/Files in bundle \(0\)/)).not.toBeInTheDocument()
  hooks.files = [file('first', 'first.mp4', 0)]
  hooks.members = undefined
  view.rerender(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('Loading bundle folders…')
})

test('initial failures offer retry without empty claims and cached errors keep content', () => {
  hooks.files = undefined
  hooks.error = new Error('Synthetic request failure')
  const view = render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load bundle files')
  fireEvent.click(screen.getByRole('button', { name: 'Retry files' }))
  expect(hooks.refetch).toHaveBeenCalledOnce()
  expect(screen.queryByText('No files in this bundle.')).not.toBeInTheDocument()
  hooks.files = [file('first', 'first.mp4', 0)]
  view.rerender(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getByRole('listitem')).toHaveTextContent('first.mp4')
  expect(screen.getByRole('alert')).toHaveTextContent('Showing cached files')
})

test('folder failures do not flatten membership and successful empty results are explicit', () => {
  hooks.members = undefined
  hooks.memberError = new Error('Synthetic folder failure')
  const view = render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.queryByRole('listitem')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Retry folders' }))
  expect(hooks.refetchMembers).toHaveBeenCalledOnce()
  hooks.members = []
  hooks.files = []
  hooks.memberError = null
  view.rerender(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getByText('No files in this bundle.')).toBeInTheDocument()
})

test('background refresh keeps the existing file list visible', () => {
  hooks.fetching = true
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByRole('status')).toHaveTextContent('Refreshing bundle files…')
})

test('pointer-drags a file card into a new bundle playback position without arrow buttons', () => {
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  const rows = screen.getAllByRole('listitem')
  const firstRow = rows[0]
  const secondRow = rows[1]
  if (!firstRow || !secondRow) throw new Error('expected two file rows')
  Object.defineProperty(firstRow, 'setPointerCapture', { value: vi.fn() })
  vi.mocked(document.elementFromPoint).mockReturnValue(secondRow)
  vi.spyOn(secondRow, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    height: 20,
  } as DOMRect)

  expect(screen.queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Move down' })).not.toBeInTheDocument()
  fireEvent.pointerDown(firstRow, { button: 0, pointerId: 1, clientX: 0, clientY: 0 })
  fireEvent.pointerMove(firstRow, { pointerId: 1, clientX: 10, clientY: 18 })
  expect(secondRow).toHaveAttribute('data-drop', 'after')
  fireEvent.pointerUp(firstRow, { pointerId: 1, clientX: 10, clientY: 18 })

  expect(hooks.reorder.mutate).toHaveBeenCalledWith(['second', 'first'])
})

test('keeps keyboard reorder and desktop Option-drag copy-out', () => {
  rememberBasis(hooks.files, 'catalog:7:plans:0')
  const onStartFileDrag = vi.fn()
  render(
    <FileList
      bundleId="bundle"
      bundleVersion={1}
      coverId={null}
      onStartFileDrag={onStartFileDrag}
    />,
  )
  const rows = screen.getAllByRole('listitem')
  const firstRow = rows[0]
  const secondRow = rows[1]
  if (!firstRow || !secondRow) throw new Error('expected two file rows')
  Object.defineProperty(firstRow, 'setPointerCapture', { value: vi.fn() })
  Object.defineProperty(firstRow, 'releasePointerCapture', { value: vi.fn() })

  fireEvent.keyDown(secondRow, { key: 'ArrowUp', altKey: true })
  expect(hooks.reorder.mutate).toHaveBeenCalledWith(['second', 'first'])
  expect(basisOf(hooks.reorder.mutate.mock.calls[0]?.[0])).toBe('catalog:7:plans:0')

  fireEvent.pointerDown(firstRow, {
    button: 0,
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    altKey: true,
  })
  fireEvent.pointerMove(firstRow, { pointerId: 1, clientX: 10, clientY: 10 })
  expect(onStartFileDrag).toHaveBeenCalledWith(['folder/first.mp4'])
})

test('places direct play after the cover action and opens the selected file', () => {
  const onPlayFile = vi.fn()
  render(<FileList bundleId="bundle" bundleVersion={1} coverId="first" onPlayFile={onPlayFile} />)
  const firstRow = screen.getAllByRole('listitem')[0]
  if (!firstRow) throw new Error('expected a file row')

  const actions = Array.from(firstRow.querySelectorAll('.file-row__actions button'))
  expect(actions.map((action) => action.getAttribute('aria-label')).slice(0, 2)).toEqual([
    'Current cover',
    'Play first.mp4',
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Play first.mp4' }))
  expect(onPlayFile).toHaveBeenCalledWith('bundle', 'first')
})

test('marks the current cover on its action instead of prefixing the filename', () => {
  render(<FileList bundleId="bundle" bundleVersion={1} coverId="first" />)
  const rows = screen.getAllByRole('listitem')
  const firstRow = rows[0]
  if (!firstRow) throw new Error('expected a file row')

  const current = screen.getByRole('button', { name: 'Current cover' })
  expect(current).toHaveClass('cover-action--active')
  expect(current).toHaveAttribute('aria-pressed', 'true')
  expect(firstRow.querySelector('.file-row__name')).not.toHaveTextContent('★')
  fireEvent.click(current)
  expect(hooks.update.mutate).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Set as cover' }))
  expect(hooks.update.mutate).toHaveBeenCalledWith({ cover_file_id: 'second' })
})
