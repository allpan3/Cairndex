import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { setActiveLibraryId } from '../api/client'
import type { Entity } from '../api/catalog'
import { CatalogBundleInspector } from './CatalogBundleInspector'

const saved = vi.hoisted(() => vi.fn())
vi.mock('../api/useReplicaStatus', () => ({ useReplicaStatus: () => ({ data: {} }) }))
vi.mock('./useCatalogBundleDraft', () => ({
  useCatalogBundleDraft: () => {
    const [notes, setNotes] = useState(['first note', 'second note', 'third note'])
    return {
      read: (field: string) => (field === 'notes' ? JSON.stringify(JSON.stringify(notes)) : 'null'),
      change: (field: string, value: string) => {
        if (field === 'notes') setNotes(JSON.parse(JSON.parse(value)))
      },
      draft: { inputs: {}, pending: null },
      error: '',
      busy: false,
      copies: [],
      message: '',
      save: saved,
      discard: vi.fn(),
      recover: vi.fn(),
    }
  },
}))

beforeEach(() => {
  setActiveLibraryId('synthetic-library')
  saved.mockClear()
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn() })
})

function setup() {
  const entity = {
    id: 'synthetic-bundle',
    has_conflicts: false,
    fields: { title: { unit: 'title' }, notes: { unit: 'notes' } },
  } as unknown as Entity
  render(
    <CatalogBundleInspector
      library="synthetic-library"
      entity={entity}
      editor="synthetic-editor"
      inspectorEnabled={false}
      blocked={false}
      refresh={vi.fn()}
      onReview={vi.fn()}
      onOpenFile={vi.fn()}
    />,
  )
}

function texts() {
  return screen
    .getAllByRole<HTMLTextAreaElement>('textbox', { name: /^Note/ })
    .map((box) => box.value)
}

test('dragging a portable note changes its retained order without submitting it', () => {
  setup()
  const target = screen.getByRole('textbox', { name: 'Note 1' }).closest('.note-row')!
  const grip = screen.getByRole('button', { name: 'Reorder note 3' })
  Object.defineProperty(grip, 'setPointerCapture', { value: vi.fn() })
  vi.mocked(document.elementFromPoint).mockReturnValue(target)
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ top: 0, height: 20 } as DOMRect)
  fireEvent.pointerDown(grip, { button: 0, pointerId: 1, clientX: 0, clientY: 100 })
  fireEvent.pointerMove(grip, { pointerId: 1, clientX: 0, clientY: 5 })
  expect(target).toHaveAttribute('data-drop', 'before')
  fireEvent.pointerUp(grip, { pointerId: 1, clientX: 0, clientY: 5 })
  expect(texts()).toEqual(['third note', 'first note', 'second note'])
  expect(saved).not.toHaveBeenCalled()
})

test('keyboard note ordering retains the pointer order and ignores the outer edge', () => {
  setup()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder note 1' }), { key: 'ArrowUp' })
  expect(texts()).toEqual(['first note', 'second note', 'third note'])
  fireEvent.keyDown(screen.getByRole('button', { name: 'Reorder note 1' }), { key: 'ArrowDown' })
  expect(texts()).toEqual(['second note', 'first note', 'third note'])
})
