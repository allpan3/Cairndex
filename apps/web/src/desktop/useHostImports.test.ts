import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { conflictName, hostImportMessage, useHostImports } from './useHostImports'

// Copying Finder-dropped files into the library (plan 4 W5, desktop half).
// The shell command is mocked — what matters here is the flow around it, which
// has to match the browser upload flow rule for rule.

const importDroppedFile = vi.fn()
const startImportBatch = vi.fn()
const cancelImportBatch = vi.fn()
const finishImportBatch = vi.fn()
vi.mock('../platform', () => ({
  importHostDroppedFile: (request: unknown) => importDroppedFile(request),
  startHostImportBatch: (batchId: string) => startImportBatch(batchId),
  cancelHostImportBatch: (batchId: string) => cancelImportBatch(batchId),
  finishHostImportBatch: (batchId: string) => finishImportBatch(batchId),
  // No byte ticks in the test; the progress subscription is a no-op.
  listenHostImportProgress: () => Promise.resolve(() => undefined),
}))

const flashes: { message: string; undo?: () => void }[] = []
const undone: string[] = []

function setup(destDir = 'Show') {
  flashes.length = 0
  undone.length = 0
  return renderHook(() =>
    useHostImports({
      libraryId: 'lib-1',
      destDir,
      onFlash: (message, undo) => flashes.push({ message, undo }),
      onImported: (operationId) => ({ undo: () => undone.push(operationId) }),
    }),
  )
}

const outcome = (path: string, id = 'op-1') => ({
  path,
  operationId: id,
  sizeBytes: 10,
  skipped: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  startImportBatch.mockResolvedValue(undefined)
  cancelImportBatch.mockResolvedValue(true)
  finishImportBatch.mockResolvedValue(undefined)
})

test('copies a dropped file into the folder being browsed', async () => {
  importDroppedFile.mockResolvedValue(outcome('Show/clip.mkv'))
  const { result } = setup()

  act(() => result.current.copyIn(['/Users/me/Movies/clip.mkv']))

  await waitFor(() => expect(importDroppedFile).toHaveBeenCalled())
  expect(importDroppedFile).toHaveBeenCalledWith({
    libraryId: 'lib-1',
    batchId: expect.any(String),
    path: '/Users/me/Movies/clip.mkv',
    destDir: 'Show',
    onConflict: undefined,
  })
  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('Copied “clip.mkv” into the library.')
  // Undoable like every other write-mode operation.
  flashes[0]?.undo?.()
  expect(undone).toEqual(['op-1'])
})

test('uploads one file at a time', async () => {
  let releaseFirst: ((value: unknown) => void) | undefined
  importDroppedFile
    .mockImplementationOnce(() => new Promise((resolve) => (releaseFirst = resolve)))
    .mockResolvedValue(outcome('Show/b.mkv', 'op-2'))
  const { result } = setup()

  act(() => result.current.copyIn(['/tmp/a.mkv', '/tmp/b.mkv']))

  await waitFor(() => expect(importDroppedFile).toHaveBeenCalledTimes(1))
  expect(result.current.activity).toMatchObject({ name: 'a.mkv', index: 1, total: 2 })

  act(() => releaseFirst?.(outcome('Show/a.mkv')))

  await waitFor(() => expect(importDroppedFile).toHaveBeenCalledTimes(2))
})

test('a collision asks, then resumes the rest of the drop', async () => {
  // Tauri rejects with the serialized error value, not an Error instance.
  importDroppedFile
    .mockRejectedValueOnce({ code: 'path_conflict', conflictingName: 'a.mkv', message: 'exists' })
    .mockResolvedValue(outcome('Show/a (2).mkv', 'op-3'))
  const { result } = setup()

  act(() => result.current.copyIn(['/tmp/a.mkv', '/tmp/b.mkv']))

  await waitFor(() => expect(result.current.conflict?.conflictingName).toBe('a.mkv'))
  // Nothing after the collision has been sent yet.
  expect(importDroppedFile).toHaveBeenCalledTimes(1)

  act(() => result.current.replace())

  await waitFor(() => expect(importDroppedFile).toHaveBeenCalledTimes(3))
  expect(importDroppedFile.mock.calls[1]?.[0]).toMatchObject({
    path: '/tmp/a.mkv',
    onConflict: 'replace',
  })
  // The answer was about that file only — the remainder asks for itself.
  expect(importDroppedFile.mock.calls[2]?.[0]).toMatchObject({
    path: '/tmp/b.mkv',
    onConflict: undefined,
  })
})

test('dismissing a collision abandons the rest without sending anything', async () => {
  importDroppedFile.mockRejectedValue({ code: 'path_conflict', conflictingName: 'a.mkv' })
  const { result } = setup()

  act(() => result.current.copyIn(['/tmp/a.mkv', '/tmp/b.mkv']))
  await waitFor(() => expect(result.current.conflict).not.toBeNull())
  act(() => result.current.dismiss())

  expect(result.current.conflict).toBeNull()
  expect(importDroppedFile).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(result.current.activity).toBeNull())
  expect(flashes.at(-1)?.message).toContain('2 not attempted')
})

test('stop crosses IPC and interrupts the file already streaming', async () => {
  let rejectUpload: ((reason: unknown) => void) | undefined
  importDroppedFile.mockImplementation(() => new Promise((_, reject) => (rejectUpload = reject)))
  cancelImportBatch.mockImplementation(async () => {
    rejectUpload?.({ code: 'import_cancelled', message: 'The import was stopped.' })
    return true
  })
  const { result } = setup()

  act(() => result.current.copyIn(['/tmp/a.mkv', '/tmp/b.mkv']))
  await waitFor(() => expect(importDroppedFile).toHaveBeenCalledTimes(1))
  const batchId = importDroppedFile.mock.calls[0]?.[0].batchId as string

  act(() => result.current.stop())

  expect(result.current.activity?.status).toBe('stopping')
  expect(cancelImportBatch).toHaveBeenCalledWith(batchId)
  await waitFor(() => expect(result.current.activity).toBeNull())
  expect(importDroppedFile).toHaveBeenCalledTimes(1)
  expect(finishImportBatch).toHaveBeenCalledWith(batchId)
  expect(flashes.at(-1)?.message).toContain('1 stopped mid-upload, 1 not attempted')
})

test('a refused import reports the shell’s reason and offers no undo', async () => {
  importDroppedFile.mockRejectedValue({
    code: 'not_dropped',
    message: 'That file was not part of a drop into this window.',
  })
  const { result } = setup()

  act(() => result.current.copyIn(['/etc/passwd']))

  await waitFor(() => expect(flashes).toHaveLength(1))
  expect(flashes[0]?.message).toBe('That file was not part of a drop into this window.')
  expect(flashes[0]?.undo).toBeUndefined()
})

test('a drop with the Files surface closed lands in the library root', async () => {
  importDroppedFile.mockResolvedValue(outcome('clip.mkv'))
  const { result } = setup('')

  act(() => result.current.copyIn(['/tmp/clip.mkv']))

  await waitFor(() => expect(importDroppedFile).toHaveBeenCalled())
  expect(importDroppedFile.mock.calls[0]?.[0]).toMatchObject({ destDir: '' })
})

// --- error-shape helpers -----------------------------------------------------

test('only a path_conflict routes to the prompt', () => {
  expect(conflictName({ code: 'path_conflict', conflictingName: 'a.mkv' })).toBe('a.mkv')
  // A conflict whose name the shell could not read still opens the prompt.
  expect(conflictName({ code: 'path_conflict' })).toBe('')
  expect(conflictName({ code: 'upload_failed', message: 'nope' })).toBeNull()
  expect(conflictName(new Error('boom'))).toBeNull()
  expect(conflictName(null)).toBeNull()
})

test('a failure without a message still says something useful', () => {
  expect(hostImportMessage({ message: 'Could not reach the server.' }, 'a.mkv')).toBe(
    'Could not reach the server.',
  )
  expect(hostImportMessage({}, 'a.mkv')).toBe('Could not copy “a.mkv” into the library.')
})

test('a self-import refusal reaches the owner in the shell’s own words', () => {
  // The guard lives in the shell, because the import endpoint receives bytes and
  // no path by design and so cannot see that the source was already in the
  // library. Its refusal is only useful if it is shown rather than flattened
  // into a generic failure.
  const refusal = {
    code: 'already_in_library',
    message: 'That file is already in this library. Use Move to… to file it somewhere else.',
  }

  expect(hostImportMessage(refusal, 'clip.mkv')).toBe(refusal.message)
  // And it is not mistaken for a collision, which would open the Replace prompt
  // — the one answer that would trash the original row.
  expect(conflictName(refusal)).toBeNull()
})
