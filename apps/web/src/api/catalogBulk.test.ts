import { beforeEach, expect, test, vi } from 'vitest'

import { catalog } from './catalog'
import {
  CatalogBulkIncomplete,
  readSelectionMemberships,
  runBulk,
  selectionKey,
} from './catalogBulk'

vi.mock('./catalog', () => ({
  catalog: vi.fn(),
  operationId: () => 'synthetic-operation',
  CatalogJobError: class extends Error {},
}))

beforeEach(() => {
  vi.mocked(catalog).mockReset()
})

const items = Array.from({ length: 1201 }, (_, index) => ({ id: `bundle-${index}`, observed: {} }))

test('staging pages the selection, follows progress and lists what was left unchanged', async () => {
  const polls = [
    { state: 'queued', result: { total: 1201, applied: 100, skipped: 0 } },
    { state: 'succeeded', result: { total: 1201, applied: 1199, skipped: 2 } },
  ]
  vi.mocked(catalog).mockImplementation(async (_library, path, _method, body) => {
    if (path.startsWith('/bundles/selection/bulk/synthetic-operation/unchanged'))
      return path.endsWith('start=0')
        ? ({ items: ['bundle-7'], next_start: 900 } as never)
        : ({ items: ['bundle-901'], next_start: null } as never)
    if (path.startsWith('/bundles/selection/bulk/'))
      return { staged: (body as { start: number }).start + 500 } as never
    if (path === '/jobs')
      return { id: 'synthetic-operation', state: 'queued', result: null } as never
    return { id: 'synthetic-operation', ...polls.shift() } as never
  })
  const outcome = runBulk('library', items, { action: 'dissolve' })
  await expect(outcome).rejects.toBeInstanceOf(CatalogBulkIncomplete)
  await outcome.catch((reason: CatalogBulkIncomplete) => {
    expect(reason.unchanged).toEqual(['bundle-7', 'bundle-901'])
    expect(reason.message).toContain('Changed 1,199 of 1,201 bundles')
  })
  const staged = vi
    .mocked(catalog)
    .mock.calls.filter(([, path]) => path === '/bundles/selection/bulk/synthetic-operation')
    .map(([, , , body]) => (body as { start: number; items: unknown[] }).items.length)
  expect(staged).toEqual([500, 500, 201])
})

test('a destination is shared only when every chunk lists it as shared', async () => {
  vi.mocked(catalog).mockImplementation(async (_library, _path, _method, body) => {
    const { ids, common } = body as { ids: string[]; common?: boolean }
    const first = ids[0] === 'bundle-0'
    const listed = common
      ? first
        ? ['everywhere', 'first-only']
        : ['everywhere']
      : ['everywhere', 'first-only', 'partial']
    return {
      items: listed.map((id) => ({ id, name: id, assigned_count: 1, observed: {}, held: false })),
      next_cursor: null,
    } as never
  })
  const read = await readSelectionMemberships(
    'library',
    items.slice(0, 150).map((item) => item.id),
    'tags',
  )
  expect(read.common.map((item) => item.id)).toEqual(['everywhere'])
  expect([...read.some].sort()).toEqual(['first-only', 'partial'])
})

test('names a large selection by its size and digest, and a small one by its IDs', () => {
  const many = Array.from({ length: 500 }, (_, index) => `bundle-${index}`)
  expect(selectionKey(['a', 'b'])).toEqual(['a', 'b'])
  expect(selectionKey(many)).toBe(selectionKey([...many]))
  expect(selectionKey(many)).toMatch(/^500:[0-9a-f]+$/)
  expect(selectionKey(many)).not.toBe(selectionKey([...many.slice(0, 499), 'bundle-x']))
})
