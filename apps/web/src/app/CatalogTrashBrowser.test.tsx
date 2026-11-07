import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { sourceRequest, type ReceiptPage } from '../api/sourceOperations'
import { CatalogTrashBrowser } from './CatalogTrashBrowser'
import { useTrash } from './useSourceLists'
import type { SourceTasks } from './useSourceTasks'

vi.mock('../api/sourceOperations', () => ({ sourceRequest: vi.fn() }))

function item(id: string, action = 'retain'): ReceiptPage['items'][number] {
  return {
    id,
    state: 'local',
    error: null,
    receipt: {
      operation: id,
      action,
      source: `${id}.txt`,
      destination: '',
      undo_of: null,
      versions_before: {},
      versions_after: {},
      metadata: null,
    },
  }
}

function mount(start: ReturnType<typeof vi.fn>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  function Browser() {
    const trash = useTrash('synthetic', true, true)
    return (
      <CatalogTrashBrowser
        trash={trash}
        tasks={{ tasks: [], start } as unknown as SourceTasks}
        writable
        onReviewEntity={() => undefined}
      />
    )
  }
  render(
    <QueryClientProvider client={client}>
      <Browser />
    </QueryClientProvider>,
  )
  return client
}

test('Empty Trash includes older pages and preserves legacy recovery copies', async () => {
  vi.mocked(sourceRequest).mockImplementation(async (_library, path) =>
    path.endsWith('older')
      ? { items: [item('older-original'), item('historical', 'trash')], next_cursor: null }
      : { items: [item('new-original')], next_cursor: 'older' },
  )
  const start = vi.fn()
  const client = mount(start)
  await screen.findByText('new-original.txt')
  fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }))
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeEnabled(),
  )
  expect(screen.getByRole('dialog')).toHaveTextContent('these 2 items')
  fireEvent.click(screen.getByRole('button', { name: 'Delete Permanently' }))
  expect(start).toHaveBeenCalledTimes(1)
  expect(start.mock.calls[0]![0]).toMatchObject({
    undoable: false,
    items: [
      { request: { action: 'purge', prior: 'new-original' } },
      { request: { action: 'purge', prior: 'older-original' } },
    ],
  })
  client.clear()
})

test('cancelling during loading cannot reopen the dialog or delete anything', async () => {
  let answer!: (page: ReceiptPage) => void
  let delayed = false
  vi.mocked(sourceRequest).mockImplementation(async () =>
    delayed
      ? new Promise<ReceiptPage>((resolve) => {
          answer = resolve
        })
      : { items: [item('original')], next_cursor: null },
  )
  const start = vi.fn()
  const client = mount(start)
  await screen.findByText('original.txt')
  delayed = true
  fireEvent.click(screen.getByRole('button', { name: 'Empty Trash…' }))
  expect(screen.getByRole('button', { name: 'Delete Permanently' })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  answer({ items: [item('original')], next_cursor: null })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(start).not.toHaveBeenCalled()
  client.clear()
})
