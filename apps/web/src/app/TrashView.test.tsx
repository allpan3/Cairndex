import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { TrashRead } from '../api/client'
import { TrashView } from './TrashView'

// The Trash view (ADR-0013 §3.2). Grouped by deletion, because a deletion is
// what Put back acts on.

const restore = vi.fn()
const empty = vi.fn()
let trash: { data: TrashRead | undefined; isLoading: boolean; isError: boolean }

vi.mock('../api/hooks', () => ({
  useTrash: () => trash,
  useRestoreFromTrash: () => ({ mutate: restore, isPending: false }),
  useEmptyTrash: () => ({ mutate: empty, isPending: false }),
}))

const FULL: TrashRead = {
  size_bytes: 2048,
  operations: [
    {
      operation_id: 'op-1',
      deleted_at: '2026-07-23T10:00:00Z',
      entries: [
        {
          original_path: 'Show/S01/ep1.mkv',
          name: 'ep1.mkv',
          file_id: 'file-1',
          is_directory: false,
          size_bytes: 1024,
        },
        {
          original_path: 'Show/S01/ep2.mkv',
          name: 'ep2.mkv',
          file_id: 'file-2',
          is_directory: false,
          size_bytes: 1024,
        },
      ],
    },
  ],
}

let flashes: string[]

function renderTrash(writeMode = true) {
  flashes = []
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <TrashView writeMode={writeMode} onFlash={(message) => flashes.push(message)} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  trash = { data: FULL, isLoading: false, isError: false }
})

test('groups entries by deletion and shows where each would go back to', () => {
  renderTrash()

  expect(screen.getByText('2 items')).toBeInTheDocument()
  // The original location is the thing a user checks before pressing Put back.
  expect(screen.getByText('Show/S01/ep1.mkv')).toBeInTheDocument()
  expect(screen.getByText('Show/S01/ep2.mkv')).toBeInTheDocument()
})

test('Put back restores the whole deletion, not one file at a time', async () => {
  renderTrash()

  fireEvent.click(screen.getByRole('button', { name: 'Put back' }))

  expect(restore).toHaveBeenCalledWith('op-1', expect.anything())
  const handlers = restore.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({ path: 'Show/S01/ep1.mkv' })
  await waitFor(() => expect(flashes).toEqual(['Restored to “Show/S01/ep1.mkv”.']))
})

test('emptying asks first, and says it cannot be undone', async () => {
  renderTrash()

  fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }))

  // The one action in write mode with no way back says so in those words, and
  // names the amount, so the confirmation is about a quantity rather than a
  // vague "everything".
  const warning = screen.getByText(/cannot be undone/)
  expect(warning).toHaveTextContent('Delete 2.0 KB permanently?')
  expect(empty).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))

  expect(empty).toHaveBeenCalled()
  const handlers = empty.mock.calls[0]?.[1] as { onSuccess: (result: unknown) => void }
  handlers.onSuccess({ operations_emptied: 1 })
  await waitFor(() => expect(flashes).toEqual(['Emptied 1 deletion.']))
})

test('cancelling the empty confirmation deletes nothing', () => {
  renderTrash()

  fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }))
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

  expect(empty).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Empty Trash…' })).toBeInTheDocument()
})

test('with write mode off the trash is readable but not actionable', () => {
  renderTrash(false)

  // The contents stay visible — turning the capability off must never make
  // trashed files look permanently gone (the server keeps the listing readable
  // for exactly this case).
  expect(screen.getByText('Show/S01/ep1.mkv')).toBeInTheDocument()
  expect(screen.getByText(/restoring needs it back on/)).toBeInTheDocument()
  // The write actions stay visible but disabled: a control that disappears
  // reads as a file that cannot come back.
  expect(screen.getByRole('button', { name: 'Put back' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Empty Trash…' })).toBeDisabled()
})

test('an empty trash explains itself rather than showing a bare blank', () => {
  trash = { data: { operations: [], size_bytes: 0 }, isLoading: false, isError: false }
  renderTrash()

  expect(screen.getByText(/Deleted files are kept here until you empty it/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Empty Trash…' })).toBeNull()
})
