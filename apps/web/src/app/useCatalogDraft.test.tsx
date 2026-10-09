import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { useCatalogDraft } from './useCatalogDraft'

vi.mock('../api/catalog', () => ({ catalog: vi.fn(), operationId: () => 'synthetic-operation' }))
vi.mock('../api/replicas', () => ({ draftKey: () => 'synthetic-draft' }))

// Each hook has isolated storage and query lifetimes without replacing its draft implementation
function setup(validate?: (body: { files: string }) => boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    () => useCatalogDraft('library', 'owner', 'editor', { files: '[]' }, validate),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.mocked(catalog).mockReset().mockResolvedValue({ items: [] })
})

// Batched native keystrokes cannot reuse one revision for different stored bodies
test('dense updates retain monotonic revisions and the newest body', () => {
  const { result } = setup()
  act(() => {
    result.current.update({ files: '["first"]' })
    result.current.update({ files: '["last"]' })
  })
  expect(JSON.parse(localStorage.getItem('synthetic-draft')!)).toMatchObject({
    revision: 2,
    body: { files: '["last"]' },
  })
  expect(result.current.body.files).toBe('["last"]')
})

// An obsolete delivery failure cannot mask a newer successful server receipt
test('ignores errors from superseded delivery generations', async () => {
  let rejectOld: (error: Error) => void = () => {}
  vi.mocked(catalog).mockImplementation(async (_library, _path, method, body) => {
    if (method === 'PUT' && (body as { revision: number }).revision === 1)
      return new Promise((_resolve, reject) => {
        rejectOld = reject
      })
    return { items: [] }
  })
  const { result } = setup()
  act(() => result.current.update({ files: '["old"]' }))
  act(() => result.current.update({ files: '["new"]' }))
  await act(async () => rejectOld(new Error('Obsolete delivery')))
  await waitFor(() => expect(result.current.error).toBe(''))
  expect(result.current.body.files).toBe('["new"]')
})

// Invalid nested draft data is reported and copied before an explicit new edit replaces it
test('retains malformed nested draft bytes while allowing a new selection', () => {
  const raw = JSON.stringify({ id: 'synthetic-old', revision: 4, body: { files: 'bad JSON' } })
  localStorage.setItem('synthetic-draft', raw)
  const { result } = setup((body) => {
    try {
      return Array.isArray(JSON.parse(body.files))
    } catch {
      return false
    }
  })
  expect(result.current.error).toContain('stored bytes are retained')
  expect(result.current.body.files).toBe('[]')
  act(() => result.current.update({ files: '["valid"]' }))
  expect(localStorage.getItem('synthetic-draft.unreadable')).toBe(raw)
})

// An acknowledged discard cannot remove input entered while its request was pending.
test('discard preserves a newer draft generation', async () => {
  let complete = () => {}
  vi.mocked(catalog).mockImplementation(async (_library, _path, method) => {
    if (method === 'DELETE')
      return new Promise<void>((resolve) => {
        complete = resolve
      })
    return { items: [] }
  })
  const { result } = setup()
  act(() => result.current.update({ files: '["first"]' }))
  let pending: Promise<void>
  act(() => {
    pending = result.current.discard()
  })
  act(() => result.current.update({ files: '["newer"]' }))
  await act(async () => {
    complete()
    await pending
  })
  expect(result.current.body.files).toBe('["newer"]')
  expect(localStorage.getItem('synthetic-draft')).toContain('newer')
})

// A source request can be saved and queued before React renders its new envelope.
test('discard acknowledges input saved in the same action', async () => {
  const { result } = setup()
  await act(async () => {
    result.current.update({ files: '["queued"]' })
    await result.current.discard()
  })
  expect(catalog).toHaveBeenCalledWith(
    'library',
    '/drafts/synthetic-operation?revision=1',
    'DELETE',
  )
  expect(result.current.body.files).toBe('[]')
  expect(localStorage.getItem('synthetic-draft')).toBeNull()
})
