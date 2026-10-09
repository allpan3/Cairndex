import { afterEach, expect, it, vi } from 'vitest'
import { catalogNavigation } from './catalogQuery'
import { advanceLibraryScope } from './requestScope'
import { catalog } from './catalog'
vi.mock('./catalog', () => ({ catalog: vi.fn() }))
afterEach(() => vi.resetAllMocks())

it('reads every navigation page without losing later hierarchy rows', async () => {
  vi.mocked(catalog)
    .mockResolvedValueOnce({ items: [{ id: 'parent' }], next_cursor: 'parent' })
    .mockResolvedValueOnce({ items: [{ id: 'child', parent_id: 'parent' }], next_cursor: null })
  expect(await catalogNavigation('library-a', 'collections')).toEqual([
    { id: 'parent' },
    { id: 'child', parent_id: 'parent' },
  ])
  expect(catalog).toHaveBeenLastCalledWith(
    'library-a',
    '/navigation/collections?after=parent&limit=50',
  )
})

it('rejects a late page and never requests another after a library switch', async () => {
  vi.mocked(catalog).mockImplementationOnce(async () => {
    advanceLibraryScope()
    return { items: [{ id: 'old' }], next_cursor: 'old' }
  })
  await expect(catalogNavigation('library-a', 'tags')).rejects.toThrow('changed')
  expect(catalog).toHaveBeenCalledTimes(1)
})
