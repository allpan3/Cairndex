import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { setActiveLibraryId, setApiBaseUrl } from '../api/client'
import { pendingEdits, sendMetadata } from '../api/metadataEdits'
import { MetadataReview } from './MetadataReview'

const basis = `${'a'.repeat(32)}:4:${'b'.repeat(32)}:0`
let library: string
let client: QueryClient
beforeEach(() => {
  setApiBaseUrl(null)
  library = crypto.randomUUID()
  setActiveLibraryId(library)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  client.clear()
  vi.unstubAllGlobals()
})
const mount = () =>
  render(
    <QueryClientProvider client={client}>
      <MetadataReview libraryId={library} />
    </QueryClientProvider>,
  )

test('the initial notice precedes editing, review retains the request, and upgrade recovery refreshes reads', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetcher)
  mount()
  expect(await screen.findByRole('status')).toHaveTextContent('Update the server')
  await act(async () => {
    await expect(
      sendMetadata(`/api/v1/libraries/${library}/bundles/amber`, 'DELETE', undefined, undefined),
    ).rejects.toThrow()
  })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Review unsaved edit 1' }))
  expect(screen.getByRole('dialog')).toHaveTextContent('Update the server')
  expect(screen.queryByRole('button', { name: 'Retry save' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Keep draft' }))
  const draft = JSON.stringify(pendingEdits())
  const refreshed = vi.fn()
  window.addEventListener('cairndex:metadata-refresh', refreshed)
  try {
    fetcher.mockImplementation(
      async () =>
        new Response(JSON.stringify({ basis }), { headers: { 'X-Cairndex-Basis': basis } }),
    )
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }))
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
    expect(refreshed).toHaveBeenCalled()
    expect(JSON.stringify(pendingEdits())).toBe(draft)
    fireEvent.click(screen.getByRole('button', { name: 'Review unsaved edit 1' }))
    expect(screen.getByRole('button', { name: 'Retry save' })).toBeInTheDocument()
  } finally {
    window.removeEventListener('cairndex:metadata-refresh', refreshed)
  }
})

test('an access failure offers a retry without asking for a server update', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 403 })))
  mount()
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Check the connection and library access',
  )
  expect(screen.getByRole('status')).not.toHaveTextContent('Update the server')
  expect(await screen.findByRole('button', { name: 'Check again' })).toBeEnabled()
})
