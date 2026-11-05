import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { sourceRequest } from '../api/sourceOperations'
import { SourceOperationReview } from './SourceOperationReview'

vi.mock('../api/sourceOperations', () => ({ sourceRequest: vi.fn() }))

afterEach(() => {
  cleanup()
  focusManager.setFocused(undefined)
})

test('a background native window receives the completed preparation', async () => {
  focusManager.setFocused(false)
  let prepared = false
  vi.mocked(sourceRequest).mockImplementation(async () => ({
    id: 'synthetic-copy',
    action: 'copy',
    state: prepared ? 'prepared' : 'queued',
    phase: 'prepare',
    progress: 5,
    request: { source: 'source.txt', destination: 'copy.txt' },
    review: {},
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <SourceOperationReview
        library="synthetic"
        operation="synthetic-copy"
        enabled
        onPrepare={vi.fn()}
      />
    </QueryClientProvider>,
  )
  await screen.findByRole('heading', { name: 'Copy: copy.txt' })
  prepared = true
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled(), {
    timeout: 2500,
  })
  view.unmount()
  client.clear()
})

test('an interrupted new-folder collision offers a new name and persistent cancel', async () => {
  const prepare = vi.fn()
  vi.mocked(sourceRequest).mockImplementation(async (_library, _path, method) =>
    method === 'DELETE'
      ? undefined
      : {
          id: 'folder',
          action: 'mkdir',
          state: 'interrupted',
          phase: 'prepare',
          progress: 0,
          error: 'Folder name is already in use; choose another name',
          result: {},
          request: { operation: 'folder', action: 'mkdir', destination: 'Trips/Taken' },
        },
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <SourceOperationReview library="synthetic" operation="folder" enabled onPrepare={prepare} />
    </QueryClientProvider>,
  )
  await screen.findByRole('button', { name: 'Cancel item' })
  expect(screen.queryByRole('button', { name: 'Try Again' })).not.toBeInTheDocument()
  fireEvent.change(screen.getByRole('textbox', { name: 'New name' }), {
    target: { value: 'Vacant' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this name' }))
  await waitFor(() =>
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ destination: 'Trips/Vacant', action: 'mkdir' }),
    ),
  )
  expect(sourceRequest).toHaveBeenCalledWith('synthetic', '/folder', 'DELETE')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel item' }))
  await waitFor(() =>
    expect(sourceRequest).toHaveBeenCalledWith('synthetic', '/folder', 'DELETE', undefined),
  )
  view.unmount()
  client.clear()
})
