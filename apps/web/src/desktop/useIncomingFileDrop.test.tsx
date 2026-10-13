import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { incomingFilesError, useIncomingFileDrop } from './useIncomingFileDrop'
import { isHostDragOutActive } from '../platform'

vi.mock('../platform', () => ({ isHostDragOutActive: vi.fn(() => false) }))
beforeEach(() => vi.clearAllMocks())
const file = () => new File(['synthetic bytes'], 'amber.txt')
function setup(enabled = true) {
  const onFiles = vi.fn(),
    onError = vi.fn()
  function Harness() {
    return <div data-testid="drop" {...useIncomingFileDrop(enabled, onFiles, onError)} />
  }
  render(<Harness />)
  return { root: screen.getByTestId('drop'), onFiles, onError }
}
function transfer(files = [file()], types = ['Files'], directory = false) {
  return {
    types,
    files,
    items: [{ webkitGetAsEntry: () => ({ isDirectory: directory }) }],
    dropEffect: 'none',
  }
}
test('external files open review without handling internal HTML drags', () => {
  const { root, onFiles, onError } = setup()
  fireEvent.drop(root, { dataTransfer: transfer([], ['application/x-cairndex-bundles']) })
  expect(onFiles).not.toHaveBeenCalled()
  const dataTransfer = transfer()
  fireEvent.dragOver(root, { dataTransfer })
  expect(dataTransfer.dropEffect).toBe('copy')
  fireEvent.drop(root, { dataTransfer })
  expect(onFiles).toHaveBeenCalledWith(dataTransfer.files)
  expect(onError).not.toHaveBeenCalled()
})
test('self-drop stays ignored when the native ended event arrives before drop', () => {
  const { root, onFiles } = setup()
  vi.mocked(isHostDragOutActive).mockReturnValue(true)
  fireEvent.dragEnter(root, { dataTransfer: transfer() })
  vi.mocked(isHostDragOutActive).mockReturnValue(false)
  fireEvent.drop(root, { dataTransfer: transfer() })
  expect(onFiles).not.toHaveBeenCalled()
})
test('modal and unavailable states prevent a new file selection', () => {
  const { root, onFiles, onError } = setup(false)
  fireEvent.drop(root, { dataTransfer: transfer() })
  expect(onFiles).not.toHaveBeenCalled()
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('unavailable'))
})
test('a visible dialog and folder drop explain their refusal', () => {
  const { root, onFiles, onError } = setup()
  const modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  fireEvent.drop(root, { dataTransfer: transfer() })
  expect(onError).toHaveBeenCalledWith(expect.stringContaining('Close'))
  modal.remove()
  fireEvent.drop(root, { dataTransfer: transfer([file()], ['Files'], true) })
  expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('Folder'))
  expect(onFiles).not.toHaveBeenCalled()
})
test('incoming selection is bounded and rejects hidden or path-like names', () => {
  expect(incomingFilesError(Array.from({ length: 129 }, file))).toContain('128 files')
  expect(incomingFilesError([{ name: 'large.mkv', size: 128 * 1024 ** 3 + 1 } as File])).toContain(
    '128 GiB',
  )
  expect(incomingFilesError([new File([], '../private.txt')])).toContain('visible names')
  expect(incomingFilesError([new File([], '.hidden')])).toContain('visible names')
  expect(incomingFilesError([new File([], 'empty.txt')])).toBeNull()
})
