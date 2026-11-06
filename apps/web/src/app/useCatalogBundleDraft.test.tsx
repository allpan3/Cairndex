import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity, type Job } from '../api/catalog'
import { advanceLibraryScope } from '../api/requestScope'
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
function setup(initial = entity(), blocked = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderHook(
    ({ value }) => useCatalogBundleDraft('library', value, 'editor', () => {}, blocked),
    {
      initialProps: { value: initial },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
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

afterEach(() => vi.useRealTimers())
const receipt = (event = 'saved-event') =>
  ({
    id: 'save',
    action: 'save',
    state: 'succeeded',
    result: { event },
    error: null,
    receipt: null,
  }) as Job

test('typing autosaves after a pause without a save action', async () => {
  vi.useFakeTimers()
  vi.mocked(runJob).mockResolvedValue(receipt())
  const { result } = setup()
  act(() => result.current.change('title', '"Changed"'))
  await act(() => vi.advanceTimersByTimeAsync(399))
  expect(runJob).not.toHaveBeenCalled()
  await act(() => vi.advanceTimersByTimeAsync(1))
  expect(runJob).toHaveBeenCalledTimes(1)
  expect(result.current.message).toBe('Saved')
  expect(result.current.draft.inputs).toEqual({})
})

test('leaving the inspector flushes edits and drains input typed during the save', async () => {
  let finish!: (value: Job) => void
  vi.mocked(runJob)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    .mockResolvedValue(receipt('second-event'))
  const { result, unmount } = setup()
  act(() => result.current.change('title', '"First"'))
  act(() => {
    void result.current.save()
  })
  act(() => result.current.change('title', '"Second"'))
  unmount()
  await act(async () => finish(receipt()))
  expect(runJob).toHaveBeenCalledTimes(2)
  expect(vi.mocked(runJob).mock.calls[1]![2]).toMatchObject({
    changes: expect.arrayContaining([
      { unit: unit('title'), value: '"Second"', basis: ['saved-event'] },
    ]),
  })
})

test('uncertain saves retry automatically with the identical operation', async () => {
  vi.useFakeTimers()
  vi.mocked(runJob).mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(receipt())
  const { result } = setup()
  act(() => result.current.change('rating', '4'))
  await act(() => vi.advanceTimersByTimeAsync(400))
  const first = vi.mocked(runJob).mock.calls[0]
  await act(() => vi.advanceTimersByTimeAsync(5000))
  expect(vi.mocked(runJob).mock.calls[1]).toEqual(first)
  expect(result.current.message).toBe('Saved')
})

test('blocked editing never autosaves, including when the inspector closes', async () => {
  vi.useFakeTimers()
  const { result, unmount } = setup(entity(), true)
  act(() => result.current.change('title', '"Retained"'))
  await act(() => vi.advanceTimersByTimeAsync(1000))
  unmount()
  expect(runJob).not.toHaveBeenCalled()
})

test('a late save cannot replace newer edits from a remounted inspector', async () => {
  let finish!: (value: Job) => void
  vi.mocked(runJob).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  const first = setup()
  act(() => first.result.current.change('title', '"First"'))
  act(() => {
    void first.result.current.save()
  })
  first.unmount()
  const next = setup()
  act(() => next.result.current.change('title', '"Newer"'))
  await act(async () => finish(receipt()))
  const recovered = setup()
  expect(recovered.result.current.read('title')).toBe('"Newer"')
})

test('several autosaves before a poll use their latest own basis without creating conflicts', async () => {
  vi.mocked(runJob)
    .mockResolvedValueOnce(receipt('first'))
    .mockResolvedValueOnce(receipt('second'))
    .mockResolvedValueOnce(receipt('third'))
  const { result } = setup()
  for (const title of ['One', 'Two', 'Three']) {
    act(() => result.current.change('title', JSON.stringify(title)))
    await act(() => result.current.save())
  }
  expect(
    vi
      .mocked(runJob)
      .mock.calls.map(
        (call) =>
          (call[2] as { changes: { unit: string; basis: string[] }[] }).changes.find(
            (change) => change.unit === unit('title'),
          )!.basis,
      ),
  ).toEqual([['seed'], ['first'], ['second']])
  expect(result.current.read('title')).toBe('"Three"')
})

test('an input handler from before acknowledgement still uses the latest saved basis', async () => {
  vi.mocked(runJob).mockResolvedValueOnce(receipt('first')).mockResolvedValueOnce(receipt('second'))
  const { result } = setup()
  act(() => result.current.change('title', '"One"'))
  const change = result.current.change
  await act(() => result.current.save())
  act(() => change('title', '"Two"'))
  await act(() => result.current.save())
  expect(vi.mocked(runJob).mock.calls[1]![2]).toMatchObject({
    changes: expect.arrayContaining([{ unit: unit('title'), value: '"Two"', basis: ['first'] }]),
  })
})

test('leaving the library retains input without starting work in the new scope', () => {
  const { result, unmount } = setup()
  act(() => result.current.change('title', '"Retained locally"'))
  advanceLibraryScope()
  unmount()
  expect(runJob).not.toHaveBeenCalled()
  const restored = setup()
  expect(restored.result.current.read('title')).toBe('"Retained locally"')
})

test('background metadata polls do not postpone an interrupted save retry', async () => {
  vi.useFakeTimers()
  vi.mocked(runJob).mockRejectedValueOnce(new Error('Disconnected')).mockResolvedValue(receipt())
  const { result, rerender } = setup()
  act(() => result.current.change('rating', '4'))
  await act(() => vi.advanceTimersByTimeAsync(400))
  for (let index = 0; index < 5; index++) {
    rerender({ value: entity() })
    await act(() => vi.advanceTimersByTimeAsync(1000))
  }
  expect(runJob).toHaveBeenCalledTimes(2)
  expect(result.current.message).toBe('Saved')
})

test('unavailable browser storage does not prevent automatic server saving', async () => {
  vi.useFakeTimers()
  vi.mocked(runJob).mockResolvedValue(receipt())
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('Storage unavailable')
  })
  try {
    const { result } = setup()
    act(() => result.current.change('title', '"Changed"'))
    await act(() => vi.advanceTimersByTimeAsync(400))
    expect(runJob).toHaveBeenCalledTimes(1)
    expect(result.current.message).toBe('Saved')
    expect(result.current.draft.inputs).toEqual({})
  } finally {
    write.mockRestore()
  }
})

test('a remounted inspector retains its own acknowledged value and basis before polling catches up', async () => {
  vi.mocked(runJob).mockResolvedValueOnce(receipt('first')).mockResolvedValueOnce(receipt('second'))
  const first = setup()
  act(() => first.result.current.change('notes', JSON.stringify(JSON.stringify(['First note']))))
  await act(() => first.result.current.save())
  first.unmount()
  const second = setup()
  expect(JSON.parse(JSON.parse(second.result.current.read('notes')))).toEqual(['First note'])
  act(() =>
    second.result.current.change(
      'notes',
      JSON.stringify(JSON.stringify(['First note', 'Second note'])),
    ),
  )
  await act(() => second.result.current.save())
  expect(vi.mocked(runJob).mock.calls[1]![2]).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({ unit: unit('notes'), basis: ['first'] }),
    ]),
    parents: expect.arrayContaining(['first']),
  })
  const peer = entity('peer')
  peer.fields.notes!.value = JSON.stringify(JSON.stringify(['Peer note']))
  second.rerender({ value: peer })
  expect(JSON.parse(JSON.parse(second.result.current.read('notes')))).toEqual(['Peer note'])
})

test('an explicit conflict choice replaces only its field draft and advances subsequent edits', async () => {
  const value = entity()
  value.fields.notes!.held = 'conflict'
  value.fields.notes!.basis = ['amber', 'blue']
  value.observed[unit('notes')] = ['amber', 'blue']
  vi.mocked(runJob).mockResolvedValue(receipt('next'))
  const { result } = setup(value)
  act(() => result.current.change('notes', JSON.stringify(JSON.stringify(['Unresolved draft']))))
  await act(() => result.current.save())
  expect(runJob).not.toHaveBeenCalled()
  const chosen = JSON.stringify(JSON.stringify(['Chosen note']))
  act(() =>
    result.current.acceptResolution(
      { [unit('notes')]: chosen },
      { [unit('notes')]: ['amber', 'blue'] },
      'resolution',
    ),
  )
  expect(result.current.read('notes')).toBe(chosen)
  expect(result.current.draft.inputs).toEqual({})
  act(() =>
    result.current.change('notes', JSON.stringify(JSON.stringify(['Chosen note', 'Next note']))),
  )
  await act(() => result.current.save())
  expect(vi.mocked(runJob).mock.calls[0]![2]).toMatchObject({
    changes: expect.arrayContaining([
      expect.objectContaining({ unit: unit('notes'), basis: ['resolution'] }),
    ]),
  })
})
