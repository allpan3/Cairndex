import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { replicaRequest, type ReplicaBundle } from '../api/replicas'
import { ReplicaEditor } from './ReplicaEditor'

vi.mock('../api/replicas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
  draftKey: () => 'synthetic-draft',
}))

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

const bundle: ReplicaBundle = {
  id: 'synthetic-bundle',
  fields: {
    title: { value: 'Synthetic title', basis: ['seed'], candidates: [] },
    notes: { value: ['Synthetic note'], basis: ['seed'], candidates: [] },
    rating: { value: null, basis: ['seed'], candidates: [] },
  },
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorage.setItem(
    'synthetic-draft',
    JSON.stringify({
      id: 'synthetic-edit',
      revision: 1,
      changes: { title: { value: 'Edited title', basis: ['seed'] } },
    }),
  )
  vi.mocked(replicaRequest).mockReset()
})

afterEach(() => vi.useRealTimers())

test.each(['success', 'failure'] as const)(
  'a late draft %s cannot change status after metadata commit',
  async (outcome) => {
    const delivery = deferred()
    const dismissal = deferred()
    vi.mocked(replicaRequest).mockImplementation(async (_library, _path, method) => {
      if (method === 'PUT') return delivery.promise
      if (method === 'DELETE') return dismissal.promise
      if (method === 'POST') return { event: 'saved-event' }
      return { items: [] }
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const refresh = vi.fn()
    const view = render(
      <QueryClientProvider client={client}>
        <ReplicaEditor
          libraryId="synthetic-library"
          bundle={bundle}
          editor="synthetic-editor"
          blocked={false}
          refresh={refresh}
        />
      </QueryClientProvider>,
    )
    await act(() => vi.advanceTimersByTimeAsync(250))
    expect(replicaRequest).toHaveBeenCalledWith(
      'synthetic-library',
      '/bundles/synthetic-bundle/drafts/synthetic-edit',
      'PUT',
      expect.objectContaining({ revision: 1 }),
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    })
    expect(replicaRequest).toHaveBeenCalledWith(
      'synthetic-library',
      '/drafts/synthetic-edit?revision=1',
      'DELETE',
    )
    // The metadata commit is complete, but dismissal keeps the draft effect active.
    await act(async () => {
      if (outcome === 'success') delivery.resolve()
      else delivery.reject(new Error('Obsolete draft failure'))
    })
    expect(screen.queryByText('Draft saved on this device')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await act(async () => dismissal.resolve())
    expect(screen.getByRole('status')).toHaveTextContent(/^Saved here$/)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled()
    expect(localStorage.getItem('synthetic-draft')).toBeNull()
    expect(refresh).toHaveBeenCalledOnce()
    view.unmount()
    client.clear()
  },
)
