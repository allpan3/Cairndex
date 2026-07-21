import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { FileRead } from '../api/client'
import { FileList } from './Inspector'

const hooks = vi.hoisted(() => ({
  files: [] as unknown[],
  reorder: { mutate: vi.fn() },
  remove: { mutate: vi.fn() },
  update: { mutate: vi.fn(), error: null },
}))

vi.mock('../api/hooks', () => ({
  useBundle: vi.fn(),
  useBundleFiles: () => ({ data: hooks.files }),
  useFileMutations: () => ({ reorder: hooks.reorder, remove: hooks.remove }),
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
  hooks.files = [file('first', 'first.mp4', 0), file('second', 'second.mp4', 1)]
  hooks.reorder.mutate.mockReset()
  hooks.remove.mutate.mockReset()
  hooks.update.mutate.mockReset()
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(),
  })
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
