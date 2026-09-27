import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity, type Job } from '../api/catalog'
import { useCatalogBundleDraft } from './useCatalogBundleDraft'
vi.mock('../api/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
  runJob: vi.fn(),
}))
const unit = (field: string) => `asset_bundles/bundle/${field}`
function entity(revision = 'seed'): Entity {
  const fields = Object.fromEntries(
    Object.entries({
      title: '"Original"',
      notes: '"[]"',
      rating: 'null',
      cover_file_id: 'null',
      $alive: 'true',
    }).map(([field, value]) => [
      field,
      {
        unit: unit(field),
        value,
        basis: [revision],
        candidates: [{ value, revisions: [revision] }],
        held: null,
        components: {},
      },
    ]),
  )
  return {
    family: 'asset_bundles',
    id: 'bundle',
    fields,
    observed: Object.fromEntries(Object.values(fields).map((field) => [field.unit, field.basis])),
    parents: [revision],
    has_conflicts: false,
  }
}
function setup(initial = entity()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(({ value }) => useCatalogBundleDraft('library', value, 'editor', () => {}), {
    initialProps: { value: initial },
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  })
}
beforeEach(() => {
  localStorage.clear()
  vi.mocked(catalog).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(runJob).mockReset()
})
test('continued input uses its own receipt while unrelated field bases stay fixed', async () => {
  let complete: (job: Job) => void = () => {}
  vi.mocked(runJob).mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  const { result, rerender } = setup()
  act(() => result.current.change('notes', '"[\\"First\\"]"'))
  let pending: Promise<void>
  act(() => {
    pending = result.current.save()
  })
  act(() => {
    result.current.change('notes', '"[\\"First\\",\\"Second\\"]"')
    result.current.change('title', '"Draft title"')
  })
  await act(async () => {
    complete({
      id: 'save',
      action: 'save',
      state: 'succeeded',
      result: { event: 'own-event' } as Job['result'],
      error: null,
      receipt: null,
    })
    await pending
  })
  expect(result.current.draft.inputs[unit('notes')]).toContain('Second')
  expect(result.current.draft.observed[unit('notes')]).toEqual(['own-event'])
  expect(result.current.draft.observed[unit('title')]).toEqual(['seed'])
  rerender({ value: entity('peer-event') })
  expect(result.current.read('title')).toBe('"Draft title"')
  expect(result.current.draft.observed[unit('title')]).toEqual(['seed'])
})
test('a failed acknowledgement retries the same operation and exact input', async () => {
  vi.mocked(runJob).mockRejectedValue(new Error('Connection lost'))
  const { result } = setup()
  act(() => result.current.change('title', '"First"'))
  await act(() => result.current.save())
  const first = vi.mocked(runJob).mock.calls[0]
  act(() =>
    result.current.recover(
      JSON.stringify({ inputs: {}, observed: {}, parents: [], pending: null }),
    ),
  )
  expect(result.current.error).toContain('Retry the pending save')
  act(() => result.current.change('title', '"Newer"'))
  await act(() => result.current.save())
  expect(vi.mocked(runJob).mock.calls[1]).toEqual(first)
  expect(result.current.read('title')).toBe('"Newer"')
})
test('ordinary save cannot consume an already observed conflict', async () => {
  const value = entity()
  value.fields.title!.basis = ['amber', 'blue']
  value.observed[unit('title')] = ['amber', 'blue']
  value.fields.title!.held = 'conflict'
  value.has_conflicts = true
  const { result } = setup(value)
  act(() => result.current.change('title', '"Replacement"'))
  await act(() => result.current.save())
  expect(runJob).not.toHaveBeenCalled()
  expect(result.current.error).toContain('Review the competing values')
  expect(result.current.read('title')).toBe('"Replacement"')
})

test('cover retry retains the selected file lifetime and exact operation after reload', async () => {
  const file: Entity = {
    ...entity(),
    family: 'asset_files',
    id: 'picture',
    fields: {
      $alive: {
        ...entity().fields.$alive!,
        unit: 'asset_files/picture/$alive',
        basis: ['file-seed'],
      },
    },
    parents: ['file-seed'],
  }
  vi.mocked(runJob).mockRejectedValue(new Error('Connection lost'))
  const first = setup()
  act(() => first.result.current.change('cover_file_id', '"picture"', [file]))
  await act(() => first.result.current.save())
  const request = vi.mocked(runJob).mock.calls[0]!
  expect(request[2]).toMatchObject({
    changes: expect.arrayContaining([
      { unit: unit('cover_file_id'), value: '"picture"', basis: ['seed'] },
      { unit: 'asset_files/picture/$alive', value: 'true', basis: ['file-seed'] },
    ]),
  })
  first.unmount()
  const restored = setup()
  expect(restored.result.current.read('cover_file_id')).toBe('"picture"')
  await act(() => restored.result.current.save())
  expect(vi.mocked(runJob).mock.calls[1]).toEqual(request)
})

test('cover selection refuses an observed deleted file', () => {
  const file = entity()
  file.fields.$alive!.value = 'false'
  const { result } = setup()
  act(() => result.current.change('cover_file_id', '"picture"', [file]))
  expect(result.current.read('cover_file_id')).toBe('null')
  expect(result.current.error).toContain('unavailable')
})
