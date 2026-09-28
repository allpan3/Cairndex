import { cleanup, render, screen, waitFor } from '@testing-library/react'
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
  await screen.findByRole('heading', { name: 'copy: queued' })
  prepared = true
  await waitFor(
    () => expect(screen.getByRole('button', { name: 'Apply reviewed operation' })).toBeEnabled(),
    { timeout: 2500 },
  )
  view.unmount()
  client.clear()
})
