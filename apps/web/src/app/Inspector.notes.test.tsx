import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { setActiveLibraryId, type BundleRead } from '../api/client'
import { Inspector } from './Inspector'

const hooks = vi.hoisted(() => ({
  bundle: undefined as unknown,
  update: { mutate: vi.fn(), error: null },
}))

vi.mock('../api/hooks', () => ({
  useBundle: () => ({ data: hooks.bundle }),
  useBundleFiles: () => ({ data: [] }),
  useFileMutations: () => ({ reorder: { mutate: vi.fn() }, remove: { mutate: vi.fn() } }),
  useForgetMissingFiles: () => ({ mutate: vi.fn() }),
  useFileRepairCandidate: vi.fn(),
  useRepairFile: vi.fn(),
  useUpdateBundle: () => hooks.update,
}))

// Neither picker has anything to do with the note box's geometry.
vi.mock('./TagEditor', () => ({ TagEditor: () => null }))
vi.mock('./CollectionPicker', () => ({ CollectionPicker: () => null }))

const HEIGHTS_KEY = 'cairndex.noteHeights.v2'

/** jsdom does no layout, so the auto-grow/drag arithmetic has nothing to read.
 *  Report the height the component itself last wrote, falling back to a stand-in
 *  "content height" while it is momentarily `auto`. */
function stubTextareaMetrics() {
  Object.defineProperty(HTMLTextAreaElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLTextAreaElement) {
      return Number.parseInt(this.style.height, 10) || 200
    },
  })
}

beforeEach(() => {
  setActiveLibraryId('library-1') // the cover thumbnail URL needs a library scope
  localStorage.clear()
  hooks.update.mutate.mockReset()
  hooks.bundle = {
    id: 'bundle-1',
    version: 1,
    title: 'A bundle',
    notes: ['a note long enough to make the box tall'],
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
  } as unknown as BundleRead
  stubTextareaMetrics()
})

afterEach(() => {
  // @ts-expect-error restoring the prototype property the stub replaced
  delete HTMLTextAreaElement.prototype.offsetHeight
})

/** The grip is `aria-hidden` (it is a pointer affordance), so reach for it by class. */
function grip(): HTMLElement {
  const el = document.querySelector('.note-resize')
  if (!(el instanceof HTMLElement)) throw new Error('expected a note resize grip')
  return el
}

function dragBy(dy: number) {
  fireEvent.pointerDown(grip(), { pointerId: 1, clientY: 500 })
  fireEvent.pointerMove(window, { pointerId: 1, clientY: 500 + dy })
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 + dy })
}

function clickGrip() {
  fireEvent.pointerDown(grip(), { pointerId: 1, clientY: 500 })
  fireEvent.pointerUp(window, { pointerId: 1, clientY: 500 })
}

function storedHeights(): unknown {
  return JSON.parse(localStorage.getItem(HEIGHTS_KEY) ?? '{}')
}

test('successive drags keep shrinking the note box instead of springing it back', () => {
  render(<Inspector bundleId="bundle-1" />)
  const box = screen.getByLabelText('Note')

  dragBy(-60)
  expect(storedHeights()).toEqual({ 'bundle-1': [140] })
  dragBy(-40)
  expect(storedHeights()).toEqual({ 'bundle-1': [100] })

  // The browser synthesises this after two quick press-release gestures on the
  // same element. Fitting to text here is what made the box read as
  // un-shrinkable: every second drag undid the first.
  fireEvent.doubleClick(grip())
  expect(storedHeights()).toEqual({ 'bundle-1': [100] })
  expect(box.style.height).toBe('100px')
})

test('double-clicking the grip without dragging still fits the box to its text', () => {
  render(<Inspector bundleId="bundle-1" />)

  dragBy(-60)
  expect(storedHeights()).toEqual({ 'bundle-1': [140] })

  // Two plain clicks, then the double-click they produce: an explicit request to
  // go back to auto-fit, which clears the stored height.
  clickGrip()
  clickGrip()
  fireEvent.doubleClick(grip())
  expect(storedHeights()).toEqual({})
})

test('a drag never shrinks the box below one line', () => {
  render(<Inspector bundleId="bundle-1" />)

  dragBy(-4000)
  expect(storedHeights()).toEqual({ 'bundle-1': [34] })
})
