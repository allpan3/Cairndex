import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from './catalog'
import { setBulkMembership } from './catalogOrganize'
import { copyCatalogTags, copiedCatalogTags, pasteCatalogTags } from './catalogTagClipboard'
import { advanceConnectionScope, advanceLibraryScope } from './requestScope'

vi.mock('./catalog', () => ({ catalog: vi.fn() }))
vi.mock('./catalogOrganize', () => ({ setBulkMembership: vi.fn() }))

beforeEach(() => {
  vi.mocked(catalog).mockReset()
  vi.mocked(setBulkMembership).mockReset()
  advanceConnectionScope('synthetic-server')
  advanceLibraryScope()
})

test('copies every assigned page and adds missing tags without removing existing ones', async () => {
  vi.mocked(catalog)
    .mockResolvedValueOnce({ items: [{ id: 'first-tag' }], next_cursor: 'first-tag' })
    .mockResolvedValueOnce({ items: [{ id: 'last-tag' }], next_cursor: null })
  expect(await copyCatalogTags('library', 'source')).toBe(2)
  expect(vi.mocked(catalog).mock.calls[1]![1]).toContain('after=first-tag')
  const existing = { id: 'first-tag', assigned_count: 2, held: false, observed: {} }
  const absent = {
    id: 'last-tag',
    assigned_count: 1,
    held: false,
    observed: { lifetime: ['read-base'] },
  }
  vi.mocked(catalog)
    .mockResolvedValueOnce({ items: [existing] })
    .mockResolvedValueOnce({ items: [absent] })
  expect(await pasteCatalogTags('library', ['one', 'two'])).toBe(2)
  expect(setBulkMembership).toHaveBeenCalledExactlyOnceWith(
    'library',
    ['one', 'two'],
    'tags',
    absent,
    true,
  )
})

test('a library or server switch never reuses another catalog clipboard', async () => {
  vi.mocked(catalog).mockResolvedValue({ items: [{ id: 'private-tag' }], next_cursor: null })
  await copyCatalogTags('original', 'source')
  expect(copiedCatalogTags('other')).toEqual([])
  advanceConnectionScope('different-server')
  expect(copiedCatalogTags('original')).toEqual([])
  expect(await pasteCatalogTags('original', ['one'])).toBe(0)
  expect(setBulkMembership).not.toHaveBeenCalled()
})

test('late copy replies cannot replace the clipboard after navigation', async () => {
  let finish: (page: unknown) => void = () => {}
  vi.mocked(catalog).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const pending = copyCatalogTags('late-library', 'source')
  advanceLibraryScope()
  finish({ items: [{ id: 'late-tag' }], next_cursor: null })
  await expect(pending).rejects.toThrow('active connection or library changed')
  expect(copiedCatalogTags('late-library')).toEqual([])
})

test('an unavailable or held tag refuses its write and never requests removal', async () => {
  vi.mocked(catalog).mockResolvedValueOnce({ items: [{ id: 'held-tag' }], next_cursor: null })
  await copyCatalogTags('library', 'source')
  vi.mocked(catalog).mockResolvedValueOnce({ items: [{ id: 'held-tag', held: true }] })
  await expect(pasteCatalogTags('library', ['one'])).rejects.toThrow('needs metadata review')
  expect(setBulkMembership).not.toHaveBeenCalled()
})
