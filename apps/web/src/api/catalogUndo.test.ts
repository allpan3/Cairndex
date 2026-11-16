import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from './catalog'
import { setBulkMembership } from './catalogOrganize'
import { plannedChange, reverseChanges } from './catalogUndo'

vi.mock('./catalog', () => ({ catalog: vi.fn() }))
vi.mock('./catalogOrganize', () => ({ setBulkMembership: vi.fn() }))

// A synthetic catalog: which bundles have the one destination
let members = new Set<string>()
const choice = (ids: string[]) => ({
  id: 'destination',
  name: 'Synthetic',
  held: false,
  assigned_count: ids.filter((id) => members.has(id)).length,
  observed: { lifetime: ['read-base'] },
})

beforeEach(() => {
  members = new Set()
  vi.mocked(setBulkMembership).mockReset()
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation((_library, _path, _method, body) =>
      Promise.resolve({ items: [choice((body as { ids: string[] }).ids)] }),
    )
})

test('a planned add leaves out the bundles that already have the destination', async () => {
  members = new Set(['b', 'e'])
  const plan = await plannedChange(
    'library',
    ['a', 'b', 'c', 'd', 'e'],
    'tags',
    'destination',
    true,
  )
  expect(plan).toEqual({
    family: 'tags',
    target: 'destination',
    assigned: true,
    ids: ['a', 'c', 'd'],
  })
})

test('a destination every bundle has, or none, takes one read', async () => {
  members = new Set(['a', 'b'])
  const remove = await plannedChange('library', ['a', 'b'], 'collections', 'destination', false)
  expect(remove?.ids).toEqual(['a', 'b'])
  expect(catalog).toHaveBeenCalledTimes(1)
})

test('a change it cannot read offers no plan rather than failing', async () => {
  const many = Array.from({ length: 101 }, (_, index) => `bundle-${index}`)
  expect(await plannedChange('library', many, 'tags', 'destination', true)).toBeNull()
  vi.mocked(catalog).mockResolvedValue({ items: [{ ...choice([]), held: true }] })
  expect(await plannedChange('library', ['a'], 'tags', 'destination', true)).toBeNull()
})

test('undo reverses the last change first, from current bases', async () => {
  members = new Set(['a'])
  await reverseChanges('library', [
    { family: 'collections', target: 'destination', assigned: false, ids: ['b'] },
    { family: 'collections', target: 'destination', assigned: true, ids: ['a'] },
  ])
  const calls = vi.mocked(setBulkMembership).mock.calls
  expect(calls.map((call) => [call[1], call[4]])).toEqual([
    [['a'], false],
    [['b'], true],
  ])
  expect(calls[0]![3]).toMatchObject({ observed: { lifetime: ['read-base'] } })
})

test('undo skips a change that is already back', async () => {
  await reverseChanges('library', [
    { family: 'tags', target: 'destination', assigned: true, ids: ['a'] },
  ])
  expect(setBulkMembership).not.toHaveBeenCalled()
})
