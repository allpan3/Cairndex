import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity, type Job } from '../api/catalog'
import { setFileStars } from '../api/catalogFiles'
import { commit, rename } from '../api/catalogOrganize'
import { setActiveLibraryId } from '../api/client'
import { draftKey } from '../api/replicas'
import { CatalogFileAnnotations } from './CatalogFileAnnotations'

const fixture = vi.hoisted(() => ({
  selectionVersion: 2,
  starred: false,
  starHeld: false,
  tagHeld: false,
  assignedTags: ['tag-amber'],
  create: vi.fn(),
  entityOverrides: {} as Partial<Entity['fields']>,
}))

vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({ data: { selection_version: fixture.selectionVersion } }),
}))

vi.mock('../api/hooks', () => ({
  useTags: () => ({
    data: [
      { id: 'tag-parent', name: 'Scene', parent_id: null, sort_order: 0 },
      { id: 'tag-blue', name: 'Blue', parent_id: 'tag-parent', sort_order: 0 },
      { id: 'tag-amber', name: 'Amber', parent_id: null, sort_order: 1 },
    ],
  }),
  useTagCounts: () => ({ data: { 'tag-amber': 2, 'tag-blue': 1 } }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: fixture.create, isPending: false, error: null }),
}))

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
  runJob: vi.fn(),
}))

vi.mock('../api/catalogOrganize', () => ({
  commit: vi.fn(),
  rename: vi.fn(),
}))

function fileEntity(hasConflict = false): Entity {
  const fields: Entity['fields'] = {
    $alive: {
      unit: 'asset_files/file-1/$alive',
      value: 'true',
      basis: ['rev-alive'],
      candidates: [{ value: 'true', revisions: ['rev-alive'] }],
      held: null,
      components: {},
    },
    note: {
      unit: 'asset_files/file-1/note',
      value: JSON.stringify('Initial note'),
      basis: ['rev-note'],
      candidates: [{ value: JSON.stringify('Initial note'), revisions: ['rev-note'] }],
      held: hasConflict ? 'conflict' : null,
      components: {},
    },
    source: {
      unit: 'asset_files/file-1/source',
      value: JSON.stringify('https://example.invalid/source'),
      basis: ['rev-source'],
      candidates: [
        { value: JSON.stringify('https://example.invalid/source'), revisions: ['rev-source'] },
      ],
      held: null,
      components: {},
    },
    ...fixture.entityOverrides,
  }
  return {
    family: 'asset_files',
    id: 'file-1',
    fields,
    observed: Object.fromEntries(Object.values(fields).map((field) => [field.unit, field.basis])),
    parents: ['rev-alive', 'rev-note', 'rev-source'],
    has_conflicts: hasConflict,
  } as unknown as Entity
}

const tagChoice = (id: string, name: string, path: string[], assigned: boolean) => ({
  id,
  name,
  parent_id: path.length > 1 ? 'tag-parent' : null,
  path,
  assigned,
  held: fixture.tagHeld,
  observed: { [`asset_file_tags/file-1~${id}/$alive`]: [`rev-${id}`] },
})

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('library')
  fixture.selectionVersion = 2
  fixture.starred = false
  fixture.starHeld = false
  fixture.tagHeld = false
  fixture.assignedTags = ['tag-amber']
  fixture.entityOverrides = {}
  fixture.create.mockReset()
  vi.mocked(commit).mockReset().mockResolvedValue()
  vi.mocked(rename).mockReset().mockResolvedValue()
  vi.mocked(runJob)
    .mockReset()
    .mockResolvedValue({
      id: 'job-save',
      action: 'save',
      state: 'succeeded',
      result: { event: 'rev-saved' },
    } as unknown as Job)
  vi.mocked(catalog)
    .mockReset()
    .mockImplementation(async (_library, path) => {
      if (path.startsWith('/drafts')) return { items: [] } as never
      if (path === '/files/file-1/star')
        return {
          file_id: 'file-1',
          starred: fixture.starred,
          held: fixture.starHeld,
          observed: { 'asset_file_stars/file-1/$alive': ['rev-star'] },
        } as never
      if (path.startsWith('/files/file-1/tags')) {
        const url = new URL(path, 'http://synthetic.invalid')
        const target = url.searchParams.get('target')
        const all = [
          tagChoice('tag-amber', 'Amber', ['Amber'], fixture.assignedTags.includes('tag-amber')),
          tagChoice(
            'tag-blue',
            'Blue',
            ['Scene', 'Blue'],
            fixture.assignedTags.includes('tag-blue'),
          ),
        ]
        if (target)
          return { items: all.filter((item) => item.id === target), next_cursor: null } as never
        const assigned = url.searchParams.get('assigned')
        if (assigned === 'true')
          return { items: all.filter((item) => item.assigned), next_cursor: null } as never
        return { items: all, next_cursor: null } as never
      }
      if (path === '/entities/asset_files/file-1') return fileEntity() as never
      throw new Error(`Unexpected catalog path ${path}`)
    })
})

afterEach(() => {
  vi.useRealTimers()
})

function setup({
  onReview = vi.fn(),
  onReviewConflict = vi.fn(),
  onFilterTag = vi.fn(),
  blocked = false,
}: {
  onReview?: () => void
  onReviewConflict?: (unit: string) => void
  onFilterTag?: (id: string) => void
  blocked?: boolean
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <CatalogFileAnnotations
        library="library"
        file="file-1"
        editor="editor-1"
        blocked={blocked}
        onReview={onReview}
        onReviewConflict={onReviewConflict}
        onFilterTag={onFilterTag}
      />
    </QueryClientProvider>,
  )
  return { ...view, onReview, onReviewConflict, onFilterTag }
}

test('Star toggle commits file_stars with observed basis and forwards held star conflicts', async () => {
  const { onReviewConflict } = setup()
  const starBtn = await screen.findByRole('button', { name: 'Star file' })
  await waitFor(() => expect(starBtn).toBeEnabled())
  fireEvent.click(starBtn)
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  expect(commit).toHaveBeenCalledWith('library', {
    action: 'file_stars',
    ids: ['file-1'],
    starred: true,
    observed: { 'asset_file_stars/file-1/$alive': ['rev-star'] },
  })

  fixture.starHeld = true
  setup({ onReviewConflict })
  const reviewBtn = await screen.findByRole('button', { name: 'Review Conflict' })
  fireEvent.click(reviewBtn)
  expect(onReviewConflict).toHaveBeenCalledWith('asset_file_stars/file-1/$alive')
})

test('File tags support tree picking, menu filter/rename/remove, and held tag conflict recovery', async () => {
  const onFilterTag = vi.fn()
  const onReviewConflict = vi.fn()
  setup({ onFilterTag, onReviewConflict })

  expect(await screen.findByRole('button', { name: 'Remove Amber' })).toBeInTheDocument()

  // Context menu: Filter, Rename, Remove
  fireEvent.click(screen.getByRole('button', { name: 'Tag actions Amber' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Filter Items with “Amber”' }))
  expect(onFilterTag).toHaveBeenCalledWith('tag-amber')

  fireEvent.click(screen.getByRole('button', { name: 'Tag actions Amber' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Tag…' }))
  const renameInput = await screen.findByLabelText('Tag name')
  fireEvent.change(renameInput, { target: { value: 'Warm Amber' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  await waitFor(() =>
    expect(rename).toHaveBeenCalledWith('library', 'tags', 'tag-amber', 'Warm Amber'),
  )

  // Add a subtag via TagPickerPanel
  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }))
  const picker = within(await screen.findByRole('dialog', { name: 'Choose tags' }))
  fireEvent.click(picker.getByRole('button', { name: /Blue/ }))
  await waitFor(() => expect(commit).toHaveBeenCalled())
  expect(commit).toHaveBeenLastCalledWith('library', {
    action: 'file_tag',
    file: 'file-1',
    target: 'tag-blue',
    assigned: true,
    observed: { 'asset_file_tags/file-1~tag-blue/$alive': ['rev-tag-blue'] },
  })

  // Close tag picker popover, verify normal unassign commit, then held tag conflict recovery
  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }))
  fireEvent.click(screen.getByRole('button', { name: 'Tag actions Amber' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from This File' }))
  await waitFor(() =>
    expect(commit).toHaveBeenLastCalledWith('library', {
      action: 'file_tag',
      file: 'file-1',
      target: 'tag-amber',
      assigned: false,
      observed: { 'asset_file_tags/file-1~tag-amber/$alive': ['rev-tag-amber'] },
    }),
  )

  fixture.tagHeld = true
  vi.mocked(commit).mockRejectedValueOnce(
    new Error('File tag membership changed or requires conflict review'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Tag actions Amber' }))
  fireEvent.click(screen.getByRole('menuitem', { name: 'Remove from This File' }))
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('needs conflict review')
  fireEvent.click(within(alert).getByRole('button', { name: 'Review Conflict' }))
  expect(onReviewConflict).toHaveBeenCalledWith('asset_file_tags/file-1~tag-amber/$alive')
})

test('File note and source save causally with $alive and retain drafts in localStorage', async () => {
  setup()
  const noteInput = await screen.findByRole('textbox', { name: 'File note' })
  const sourceInput = screen.getByRole('textbox', { name: 'File source' })
  expect(noteInput).toHaveValue('Initial note')
  expect(sourceInput).toHaveValue('https://example.invalid/source')

  fireEvent.change(noteInput, { target: { value: 'Updated note' } })
  fireEvent.change(sourceInput, { target: { value: 'https://synthetic.invalid/clip' } })

  // Draft key exists in localStorage under library-scoped file-inspector
  expect(
    localStorage.getItem(draftKey('library', 'file-inspector/file-1', 'editor-1')),
  ).not.toBeNull()

  fireEvent.blur(sourceInput)
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(1))
  expect(runJob).toHaveBeenCalledWith(
    'library',
    'save',
    {
      changes: [
        {
          unit: 'asset_files/file-1/note',
          value: JSON.stringify('Updated note'),
          basis: ['rev-note'],
        },
        {
          unit: 'asset_files/file-1/source',
          value: JSON.stringify('https://synthetic.invalid/clip'),
          basis: ['rev-source'],
        },
        {
          unit: 'asset_files/file-1/$alive',
          value: 'true',
          basis: ['rev-alive'],
        },
      ],
      parents: ['rev-alive', 'rev-note', 'rev-source'],
      resolve: false,
      recover: false,
    },
    expect.any(String),
  )
  expect(await screen.findByRole('status')).toHaveTextContent('Saved')
})

test('Conflicting file note renders Review Conflicts action targeting asset_files note unit', async () => {
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/drafts')) return { items: [] } as never
    if (path === '/files/file-1/star')
      return {
        file_id: 'file-1',
        starred: false,
        held: false,
        observed: { 'asset_file_stars/file-1/$alive': ['rev-star'] },
      } as never
    if (path.startsWith('/files/file-1/tags')) return { items: [], next_cursor: null } as never
    if (path === '/entities/asset_files/file-1') return fileEntity(true) as never
    throw new Error(`Unexpected catalog path ${path}`)
  })
  const onReviewConflict = vi.fn()
  setup({ onReviewConflict })
  const reviewBtn = await screen.findByRole('button', { name: 'Review Conflicts' })
  fireEvent.click(reviewBtn)
  expect(onReviewConflict).toHaveBeenCalledWith('asset_files/file-1/note')
})

test('Star button stays disabled while a stale invalidated star query is refetching', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <CatalogFileAnnotations library="library" file="file-1" editor="editor-1" blocked={false} />
    </QueryClientProvider>,
  )
  await waitFor(() => expect(screen.getByRole('button', { name: 'Star file' })).toBeEnabled())
  view.unmount()

  // Simulate another surface invalidating the inactive query, then delaying the fresh read
  await client.invalidateQueries({ queryKey: ['catalog-file-star', 'library'] })
  let resolveFresh!: (value: unknown) => void
  const defaultImpl = vi.mocked(catalog).getMockImplementation()!
  vi.mocked(catalog).mockImplementation(async (library, path, ...rest) => {
    if (path === '/files/file-1/star')
      return new Promise<unknown>((resolve) => {
        resolveFresh = resolve
      }) as Promise<never>
    return defaultImpl(library, path, ...rest)
  })

  render(
    <QueryClientProvider client={client}>
      <CatalogFileAnnotations library="library" file="file-1" editor="editor-1" blocked={false} />
    </QueryClientProvider>,
  )
  expect(screen.getByRole('button', { name: 'Star file' })).toBeDisabled()
  resolveFresh({
    file_id: 'file-1',
    starred: false,
    held: false,
    observed: { 'asset_file_stars/file-1/$alive': ['rev-star-fresh'] },
  })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Star file' })).toBeEnabled())
})

test('Concurrent note blur save serializes Star file and + Tag writes with fresh file bases', async () => {
  let finishSave!: (job: Job) => void
  vi.mocked(runJob).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve
      }),
  )
  const calls: string[] = []
  let saved = false
  vi.mocked(commit).mockImplementation(async (_library, command) => {
    calls.push(`commit:${(command as { action: string }).action}`)
  })
  const defaultCatalog = vi.mocked(catalog).getMockImplementation()!
  vi.mocked(catalog).mockImplementation(async (library, path, method, body) => {
    if (path === '/files/selection') {
      calls.push('read:/files/selection')
      return {
        items: [
          {
            id: 'file-1',
            starred: false,
            held: false,
            observed: {
              'asset_files/file-1/$alive': [saved ? 'rev-alive-after-save' : 'rev-alive'],
              'asset_file_stars/file-1/$alive': ['rev-star'],
            },
          },
        ],
      } as never
    }
    if (path.startsWith('/files/file-1/tags') && path.includes('target=tag-blue')) {
      calls.push('read:/files/file-1/tags?target=tag-blue')
      return {
        items: [
          {
            ...tagChoice('tag-blue', 'Blue', ['Scene', 'Blue'], false),
            observed: {
              'asset_files/file-1/$alive': [saved ? 'rev-alive-after-save' : 'rev-alive'],
              'asset_file_tags/file-1~tag-blue/$alive': ['rev-tag-blue'],
              'tags/tag-blue/$alive': ['rev-tag-node'],
            },
          },
        ],
        next_cursor: null,
      } as never
    }
    return defaultCatalog(library, path, method, body)
  })

  setup()
  const noteInput = await screen.findByRole('textbox', { name: 'File note' })
  const starBtn = await screen.findByRole('button', { name: 'Star file' })
  await waitFor(() => expect(starBtn).toBeEnabled())

  fireEvent.change(noteInput, { target: { value: 'Updated note' } })
  fireEvent.blur(noteInput)
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(1))

  // Click Star file and add Blue tag while draft.save() holds the per-file write lock.
  fireEvent.click(starBtn)
  fireEvent.click(screen.getByRole('button', { name: '+ Tag' }))
  const picker = within(await screen.findByRole('dialog', { name: 'Choose tags' }))
  fireEvent.click(picker.getByRole('button', { name: /Blue/ }))

  // Neither /files/selection, /tags?target=tag-blue, nor commit may run until save finishes.
  await act(async () => {
    await Promise.resolve()
  })
  expect(calls).toEqual([])
  expect(commit).not.toHaveBeenCalled()

  saved = true
  await act(async () => {
    finishSave({
      id: 'job-save',
      action: 'save',
      state: 'succeeded',
      result: { event: 'rev-alive-after-save' },
    } as unknown as Job)
  })

  await waitFor(() => expect(commit).toHaveBeenCalledTimes(2))
  expect(calls).toEqual([
    'read:/files/selection',
    'commit:file_stars',
    'read:/files/file-1/tags?target=tag-blue',
    'commit:file_tag',
  ])
  expect(commit).toHaveBeenNthCalledWith(1, 'library', {
    action: 'file_stars',
    ids: ['file-1'],
    starred: true,
    observed: {
      'asset_files/file-1/$alive': ['rev-alive-after-save'],
      'asset_file_stars/file-1/$alive': ['rev-star'],
    },
  })
  expect(commit).toHaveBeenNthCalledWith(2, 'library', {
    action: 'file_tag',
    file: 'file-1',
    target: 'tag-blue',
    assigned: true,
    observed: {
      'asset_files/file-1/$alive': ['rev-alive-after-save'],
      'asset_file_tags/file-1~tag-blue/$alive': ['rev-tag-blue'],
      'tags/tag-blue/$alive': ['rev-tag-node'],
    },
  })
})

test('setFileStars recovers when only unrelated file $alive moved, and refuses when star unit changed', async () => {
  vi.mocked(commit).mockRejectedValueOnce(
    new Error('Selected file metadata changed or requires conflict review; refresh choices'),
  )
  vi.mocked(commit).mockResolvedValueOnce()
  vi.mocked(catalog).mockResolvedValueOnce({
    items: [
      {
        id: 'file-1',
        starred: false,
        held: false,
        observed: {
          'asset_files/file-1/$alive': ['rev-alive-2'],
          'asset_file_stars/file-1/$alive': ['rev-star'],
        },
      },
    ],
  } as never)

  await setFileStars('library', ['file-1'], true, {
    'asset_files/file-1/$alive': ['rev-alive-1'],
    'asset_file_stars/file-1/$alive': ['rev-star'],
  })
  expect(commit).toHaveBeenCalledTimes(2)
  expect(commit).toHaveBeenNthCalledWith(2, 'library', {
    action: 'file_stars',
    ids: ['file-1'],
    starred: true,
    observed: {
      'asset_files/file-1/$alive': ['rev-alive-2'],
      'asset_file_stars/file-1/$alive': ['rev-star'],
    },
  })

  vi.mocked(commit).mockRejectedValueOnce(
    new Error('Selected file metadata changed or requires conflict review; refresh choices'),
  )
  vi.mocked(catalog).mockResolvedValueOnce({
    items: [
      {
        id: 'file-1',
        starred: true,
        held: false,
        observed: {
          'asset_files/file-1/$alive': ['rev-alive-2'],
          'asset_file_stars/file-1/$alive': ['rev-peer-star'],
        },
      },
    ],
  } as never)

  await expect(
    setFileStars('library', ['file-1'], true, {
      'asset_files/file-1/$alive': ['rev-alive-1'],
      'asset_file_stars/file-1/$alive': ['rev-star'],
    }),
  ).rejects.toThrow('Selected file metadata changed or requires conflict review')
  expect(commit).toHaveBeenCalledTimes(3)
})

test('Concurrent note blur serializes tag-chip removal and refuses when tag edge changed', async () => {
  let finishSave!: (job: Job) => void
  let saved = false
  let edgeRev = 'rev-tag-amber'
  const defaultCatalog = vi.mocked(catalog).getMockImplementation()!
  vi.mocked(catalog).mockImplementation(async (library, path, method, body) => {
    if (path.startsWith('/files/file-1/tags')) {
      const url = new URL(path, 'http://synthetic.invalid')
      const target = url.searchParams.get('target')
      const amber = {
        ...tagChoice('tag-amber', 'Amber', ['Amber'], true),
        observed: {
          'asset_files/file-1/$alive': [saved ? 'rev-alive-after-save' : 'rev-alive'],
          'asset_file_tags/file-1~tag-amber/$alive': [edgeRev],
          'tags/tag-amber/$alive': ['rev-tag-node'],
        },
      }
      if (target)
        return { items: target === 'tag-amber' ? [amber] : [], next_cursor: null } as never
      return { items: [amber], next_cursor: null } as never
    }
    return defaultCatalog(library, path, method, body)
  })

  // Case 1: Only asset_files/file-1/$alive moves during save; chip removal verifies and commits.
  vi.mocked(runJob).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve
      }),
  )
  const first = setup()
  const noteInput = await within(first.container).findByRole('textbox', { name: 'File note' })
  const removeBtn = await within(first.container).findByRole('button', { name: 'Remove Amber' })

  fireEvent.change(noteInput, { target: { value: 'Note v1' } })
  fireEvent.blur(noteInput)
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(1))

  fireEvent.click(removeBtn)
  await act(async () => {
    await Promise.resolve()
  })
  expect(commit).not.toHaveBeenCalled()

  saved = true
  await act(async () => {
    finishSave({
      id: 'job-save-1',
      action: 'save',
      state: 'succeeded',
      result: { event: 'rev-alive-after-save' },
    } as unknown as Job)
  })
  await waitFor(() => expect(commit).toHaveBeenCalledTimes(1))
  expect(commit).toHaveBeenCalledWith('library', {
    action: 'file_tag',
    file: 'file-1',
    target: 'tag-amber',
    assigned: false,
    observed: {
      'asset_files/file-1/$alive': ['rev-alive-after-save'],
      'asset_file_tags/file-1~tag-amber/$alive': ['rev-tag-amber'],
      'tags/tag-amber/$alive': ['rev-tag-node'],
    },
  })
  first.unmount()

  // Case 2: Edge revision changed while save ran -> removal refuses without committing.
  vi.mocked(commit).mockClear()
  edgeRev = 'rev-tag-amber'
  saved = false
  vi.mocked(runJob).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishSave = resolve
      }),
  )
  const second = setup()
  const noteInput2 = await within(second.container).findByRole('textbox', { name: 'File note' })
  const removeBtn2 = await within(second.container).findByRole('button', { name: 'Remove Amber' })

  fireEvent.change(noteInput2, { target: { value: 'Note v2' } })
  fireEvent.blur(noteInput2)
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(2))

  fireEvent.click(removeBtn2)
  edgeRev = 'rev-tag-amber-peer'
  saved = true
  await act(async () => {
    finishSave({
      id: 'job-save-2',
      action: 'save',
      state: 'succeeded',
      result: { event: 'rev-alive-after-save' },
    } as unknown as Job)
  })
  await expect(
    within(second.container).findByText(
      'File tag membership changed or requires conflict review; refresh choices',
    ),
  ).resolves.toBeInTheDocument()
  expect(commit).not.toHaveBeenCalled()
})
