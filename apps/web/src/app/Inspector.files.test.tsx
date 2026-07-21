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
    tech_metadata: {},
    created_at: '2026-07-21T00:00:00Z',
    updated_at: '2026-07-21T00:00:00Z',
  } as FileRead
}

/** Mutable DataTransfer surface used by React's drag handlers. */
function dragData() {
  return { effectAllowed: 'none', dropEffect: 'none' }
}

/** Drag event with modifier state, which jsdom's drag-event helper omits. */
function modifiedDragStart(dataTransfer: ReturnType<typeof dragData>) {
  const event = new MouseEvent('dragstart', { bubbles: true, cancelable: true, altKey: true })
  Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
  return event
}

beforeEach(() => {
  hooks.files = [file('first', 'first.mp4', 0), file('second', 'second.mp4', 1)]
  hooks.reorder.mutate.mockReset()
  hooks.remove.mutate.mockReset()
  hooks.update.mutate.mockReset()
})

test('drags a file card into a new bundle playback position without arrow buttons', () => {
  render(<FileList bundleId="bundle" bundleVersion={1} coverId={null} />)
  const rows = screen.getAllByRole('listitem')
  const firstRow = rows[0]
  const secondRow = rows[1]
  if (!firstRow || !secondRow) throw new Error('expected two file rows')
  const dataTransfer = dragData()
  vi.spyOn(secondRow, 'getBoundingClientRect').mockReturnValue({
    top: 0,
    height: 20,
  } as DOMRect)

  expect(screen.queryByRole('button', { name: 'Move up' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Move down' })).not.toBeInTheDocument()
  fireEvent.dragStart(firstRow, { dataTransfer })
  fireEvent.dragOver(secondRow, { dataTransfer, clientY: 18 })
  expect(secondRow).toHaveAttribute('data-drop', 'after')
  fireEvent.drop(secondRow, { dataTransfer, clientY: 18 })

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

  fireEvent.keyDown(secondRow, { key: 'ArrowUp', altKey: true })
  expect(hooks.reorder.mutate).toHaveBeenCalledWith(['second', 'first'])

  fireEvent(firstRow, modifiedDragStart(dragData()))
  expect(onStartFileDrag).toHaveBeenCalledWith(['folder/first.mp4'])
})
