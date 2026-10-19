import { beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity } from './catalog'
import {
  deleteSmartCollection,
  openSmartCollection,
  saveSmartCollection,
} from './catalogSmartCollections'

vi.mock('./catalog', () => ({ catalog: vi.fn(), runJob: vi.fn(), operationId: () => 'generated' }))

const advanced =
  '{ "version": 1, "root": { "op": "not", "child": { "field": "title", "operator": "contains", "value": "Comet" } } }'
function entity(): Entity {
  return {
    family: 'smart_folders',
    id: 'smart-one',
    has_conflicts: false,
    parents: ['opening-parent'],
    observed: {},
    fields: Object.fromEntries(
      Object.entries({
        $alive: 'true',
        name: '"Saved rules"',
        $filter: JSON.stringify({ filter_version: 1, filter_json: advanced }),
        default_sort: 'null',
      }).map(([column, value]) => [
        column,
        {
          unit: `smart_folders/smart-one/${column}`,
          value,
          basis: [`opening-${column}`],
          candidates: [],
          held: null,
          components: {},
        },
      ]),
    ),
  }
}

beforeEach(() => {
  vi.mocked(catalog).mockReset()
  vi.mocked(runJob).mockReset()
  vi.mocked(catalog).mockResolvedValue(entity())
  vi.mocked(runJob).mockResolvedValue({
    id: 'prepared',
    receipt: 'receipt',
    state: 'succeeded',
  } as never)
})

test('renaming advanced rules uses opening bases without rewriting filter text or consuming newer bases', async () => {
  const opening = await openSmartCollection('library', 'smart-one')
  const newer = entity()
  newer.fields.name!.basis = ['later-name']
  vi.mocked(catalog).mockResolvedValue(newer)
  await saveSmartCollection('library', opening, ' Renamed ', null, 'exact-save')
  expect(runJob).toHaveBeenCalledWith(
    'library',
    'preview',
    {
      action: 'smart_collection',
      entity: 'smart-one',
      name: 'Renamed',
      observed: {
        'smart_folders/smart-one/name': ['opening-name'],
        'smart_folders/smart-one/$alive': ['opening-$alive'],
      },
    },
    'exact-save',
  )
  expect(opening.entity!.fields.$filter!.value).toContain(JSON.stringify(advanced).slice(1, -1))
  expect(catalog).toHaveBeenCalledTimes(2)
})

test('deletion guards the displayed filter and name as well as lifetime', async () => {
  const opening = await openSmartCollection('library', 'smart-one')
  await deleteSmartCollection('library', opening, 'exact-delete')
  const request = vi.mocked(runJob).mock.calls[0]![2] as {
    delete: boolean
    observed: Record<string, string[]>
  }
  expect(request.delete).toBe(true)
  expect(request.observed['smart_folders/smart-one/$alive']).toEqual(['opening-$alive'])
  expect(request.observed['smart_folders/smart-one/$filter']).toEqual(['opening-$filter'])
  expect(request.observed['smart_folders/smart-one/name']).toEqual(['opening-name'])
})

test('a creation retry keeps its original identity and exact preview operation', async () => {
  vi.mocked(catalog).mockResolvedValue({
    cells: { id: '"created-one"', name: '""', filter_version: '1', filter_json: '"{}"' },
  })
  const opening = await openSmartCollection('library', null)
  const filter = { version: 1 as const, root: null }
  vi.mocked(runJob).mockResolvedValueOnce({ id: 'prepared', receipt: 'receipt' } as never)
  vi.mocked(runJob).mockRejectedValueOnce(new Error('Lost commit reply'))
  await expect(
    saveSmartCollection('library', opening, 'Comet', filter, 'exact-create'),
  ).rejects.toThrow('Lost commit reply')
  expect(await saveSmartCollection('library', opening, 'Comet', filter, 'exact-create')).toBe(
    'created-one',
  )
  const previews = vi.mocked(runJob).mock.calls.filter(([, action]) => action === 'preview')
  expect(previews).toHaveLength(2)
  expect(previews[1]).toEqual(previews[0])
  expect(catalog).toHaveBeenCalledTimes(2)
})

test('held or deleted Smart Collections refuse ordinary opening', async () => {
  const held = entity()
  held.fields.$filter!.held = 'unresolved'
  vi.mocked(catalog).mockResolvedValue(held)
  await expect(openSmartCollection('library', 'smart-one')).rejects.toThrow('metadata review')
  const deleted = entity()
  deleted.fields.$alive!.value = 'false'
  vi.mocked(catalog).mockResolvedValue(deleted)
  await expect(openSmartCollection('library', 'smart-one')).rejects.toThrow('metadata review')
  expect(runJob).not.toHaveBeenCalled()
})

test('a competing change during commit keeps the editor in metadata review', async () => {
  const opening = await openSmartCollection('library', 'smart-one')
  vi.mocked(catalog).mockResolvedValue({ ...entity(), has_conflicts: true })
  await expect(
    saveSmartCollection('library', opening, 'Competing name', null, 'exact-save'),
  ).rejects.toThrow('competing changes')
})
