import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { PathConflictError } from '../api/client'
import { useWebImports } from './useWebImports'

const importOne = vi.fn()
const undo = vi.fn()

vi.mock('../api/hooks', () => ({
  useFileOperations: () => ({
    importOne: { mutateAsync: importOne },
    undo: { mutate: undo },
  }),
}))

const flashes: { message: string; undo?: () => void }[] = []

const imported = (path: string, id: string, skipped = false) => ({
  path,
  operation: { id },
  files_updated: 0,
  failed_paths: [],
  skipped,
  size_bytes: skipped ? 0 : 1,
})

function setup() {
  flashes.length = 0
  return renderHook(() =>
    useWebImports({
      onFlash: (message, undoAction) => flashes.push({ message, undo: undoAction }),
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

test('browser files upload sequentially', async () => {
  let finishFirst: ((value: unknown) => void) | undefined
  importOne
    .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValue(imported('Show/b.mkv', 'op-2'))
  const { result } = setup()

  act(() => result.current.copyIn([new File(['a'], 'a.mkv'), new File(['b'], 'b.mkv')], 'Show'))

  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(1))
  expect(result.current.activity).toMatchObject({ name: 'a.mkv', index: 1, total: 2 })

  act(() => finishFirst?.(imported('Show/a.mkv', 'op-1')))
  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(2))
})

test('a collision waits on the same file and resumes the untouched remainder', async () => {
  importOne
    .mockRejectedValueOnce(new PathConflictError('exists', 'a.mkv', 'Show/a.mkv'))
    .mockResolvedValueOnce(imported('Show/a (2).mkv', 'op-1'))
    .mockResolvedValueOnce(imported('Show/b.mkv', 'op-2'))
  const { result } = setup()

  act(() => result.current.copyIn([new File(['a'], 'a.mkv'), new File(['b'], 'b.mkv')], 'Show'))

  await waitFor(() => expect(result.current.activity?.status).toBe('waiting'))
  expect(result.current.conflict?.conflictingName).toBe('a.mkv')
  expect(importOne).toHaveBeenCalledTimes(1)

  act(() => result.current.keepBoth())

  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(3))
  expect(importOne.mock.calls[1]?.[0]).toMatchObject({ onConflict: 'suffix' })
  expect(importOne.mock.calls[2]?.[0]).toMatchObject({ onConflict: undefined })
})

test('stop aborts the current request and reports the committed partial batch', async () => {
  let activeSignal: AbortSignal | undefined
  importOne
    .mockResolvedValueOnce(imported('Show/a.mkv', 'op-1'))
    .mockResolvedValueOnce(imported('Show/b.mkv', 'op-skip', true))
    .mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          activeSignal = signal
          signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')))
        }),
    )
  const { result } = setup()

  act(() =>
    result.current.copyIn(
      [
        new File(['a'], 'a.mkv'),
        new File(['b'], 'b.mkv'),
        new File(['c'], 'c.mkv'),
        new File(['d'], 'd.mkv'),
      ],
      'Show',
    ),
  )
  await waitFor(() => expect(importOne).toHaveBeenCalledTimes(3))

  act(() => result.current.stop())

  expect(activeSignal?.aborted).toBe(true)
  expect(result.current.activity?.status).toBe('stopping')
  await waitFor(() => expect(result.current.activity).toBeNull())
  expect(importOne).toHaveBeenCalledTimes(3)
  expect(flashes.at(-1)?.message).toBe(
    'Import stopped: 1 imported, 1 skipped, 1 stopped mid-upload, 1 not attempted. Imported files remain in the library and can each be undone.',
  )
})

test('the import row leaves before caller-specific settled work runs', async () => {
  let finishSettled: (() => void) | undefined
  const onSettled = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finishSettled = resolve
      }),
  )
  importOne.mockResolvedValue(imported('Show/a.mkv', 'op-1'))
  const { result } = setup()

  act(() =>
    result.current.copyIn([new File(['a'], 'a.mkv')], 'Show', {
      onSettled,
    }),
  )

  await waitFor(() => expect(onSettled).toHaveBeenCalledOnce())
  expect(result.current.activity).toBeNull()

  act(() => finishSettled?.())
})
