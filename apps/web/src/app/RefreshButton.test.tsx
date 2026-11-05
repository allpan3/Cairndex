import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { expect, test, vi } from 'vitest'
import { RefreshButton } from './RefreshButton'

test('Refresh reads what is shown again and marks the rest for a new read', async () => {
  // Fresh for 30 seconds, so nothing refetches unless Refresh asks
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  })
  client.setQueryData(['catalog-browse', 'library', 'another-collection'], [])
  const listing = vi.fn(async () => 'Synthetic folder')
  function Shown() {
    const query = useQuery({
      queryKey: ['catalog-local-directory', 'library', ''],
      queryFn: listing,
    })
    return <p>{query.data}</p>
  }
  render(
    <QueryClientProvider client={client}>
      <RefreshButton />
      <Shown />
    </QueryClientProvider>,
  )
  await screen.findByText('Synthetic folder')
  expect(listing).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(listing).toHaveBeenCalledTimes(2))
  expect(
    client.getQueryState(['catalog-browse', 'library', 'another-collection'])?.isInvalidated,
  ).toBe(true)
})
