import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { TagRead } from './client'
import { useCreateTagPath } from './hooks'

const mocks = vi.hoisted(() => ({ createTag: vi.fn() }))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createTag: mocks.createTag,
}))

function tag(id: string, name: string, parentId: string | null = null): TagRead {
  return {
    id,
    name,
    parent_id: parentId,
    color: null,
    sort_order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    version: 1,
  }
}

function renderCreate() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(() => useCreateTagPath(), {
    wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
  })
}

beforeEach(() => {
  mocks.createTag.mockReset()
  let seq = 0
  mocks.createTag.mockImplementation(({ name, parent_id }) =>
    Promise.resolve(tag(`t${++seq}`, name, parent_id ?? null)),
  )
})

test('a plain name creates one top-level tag', async () => {
  const { result } = renderCreate()

  result.current.mutate({ path: 'noir', existing: [] })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(mocks.createTag).toHaveBeenCalledExactlyOnceWith({ name: 'noir', parent_id: null })
})

test('slashes create the chain and resolve to the leaf', async () => {
  const { result } = renderCreate()

  result.current.mutate({ path: 'genre/noir/classic', existing: [] })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(mocks.createTag.mock.calls.map(([p]) => p)).toEqual([
    { name: 'genre', parent_id: null },
    { name: 'noir', parent_id: 't1' },
    { name: 'classic', parent_id: 't2' },
  ])
  expect(result.current.data?.name).toBe('classic')
})

test('existing ancestors are reused case-insensitively, per parent', async () => {
  // A top-level `Genre` exists, and an unrelated `noir` lives under `other` —
  // only the same-parent match may be reused, or `a/b` would nest under a
  // stranger with the same name.
  const existing = [tag('g1', 'Genre'), tag('o1', 'other'), tag('n1', 'noir', 'o1')]
  const { result } = renderCreate()

  result.current.mutate({ path: 'genre/noir', existing })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(mocks.createTag).toHaveBeenCalledExactlyOnceWith({ name: 'noir', parent_id: 'g1' })
})

test('a fully existing path creates nothing and returns the leaf', async () => {
  const existing = [tag('g1', 'genre'), tag('n1', 'noir', 'g1')]
  const { result } = renderCreate()

  result.current.mutate({ path: 'genre/noir', existing })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(mocks.createTag).not.toHaveBeenCalled()
  expect(result.current.data?.id).toBe('n1')
})

test('blank segments and stray slashes are ignored', async () => {
  const { result } = renderCreate()

  result.current.mutate({ path: ' /genre//noir/ ', existing: [] })
  await waitFor(() => expect(result.current.isSuccess).toBe(true))

  expect(mocks.createTag.mock.calls.map(([p]) => p.name)).toEqual(['genre', 'noir'])
})
