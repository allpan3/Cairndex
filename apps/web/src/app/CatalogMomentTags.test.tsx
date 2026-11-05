import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { runJob, type Job } from '../api/catalog'
import type { Moment } from '../api/client'
import { setActiveLibraryId } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogMomentTags } from './CatalogMomentTags'

const fixture = vi.hoisted(() => ({ version: 5, held: false, create: vi.fn() }))
vi.mock('../api/useReplicaStatus', () => ({
  useReplicaStatus: () => ({ data: { moments_version: fixture.version } }),
}))
vi.mock('../api/hooks', () => ({
  useTags: () => ({
    data: [
      { id: 'parent', name: 'Scene', parent_id: null, sort_order: 0 },
      { id: 'tag-c', name: 'Harbor', parent_id: 'parent', sort_order: 0 },
      { id: 'tag-a', name: 'Synthetic one', parent_id: null, sort_order: 1 },
      { id: 'tag-b', name: 'Synthetic two', parent_id: null, sort_order: 2 },
    ],
  }),
  useTagCounts: () => ({ data: { 'tag-c': 2 } }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: fixture.create, isPending: false, error: null }),
}))

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  runJob: vi.fn(),
}))
vi.mock('../api/replicas', async (original) => ({
  ...(await original<typeof import('../api/replicas')>()),
  replicaRequest: vi.fn(),
}))

const moment = {
  id: 'moment-1',
  bundle_id: 'bundle',
  file_id: 'file',
  start_s: 4,
  end_s: null,
  comment: null,
  tag_ids: ['tag-a', 'tag-b'],
} as unknown as Moment

const choice = (id: string, name: string, assigned: boolean) => ({
  id,
  name,
  parent_id: null,
  path: [name],
  assigned,
  observed: { [`moments/moment-1/$alive`]: ['seen'] },
  held: false,
})

beforeEach(() => {
  setActiveLibraryId('synthetic')
  fixture.version = 5
  fixture.held = false
  fixture.create.mockReset()
  vi.mocked(runJob).mockReset()
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
    const target = new URL(path, 'http://synthetic.invalid').searchParams.get('target')
    if (target)
      return {
        items: [{ ...choice(target, target, false), held: fixture.held }],
        next_cursor: null,
      }
    if (path.includes('assigned=true'))
      return {
        items: [choice('tag-a', 'Synthetic one', true), choice('tag-b', 'Synthetic two', true)],
        next_cursor: null,
      }
    return {
      items: [choice('tag-a', 'Synthetic one', true), choice('tag-c', 'Synthetic three', false)],
      next_cursor: null,
    }
  })
})

// The row shows one tag in full and a count; the chooser saves one tag at a time
test('a moment tag is chosen and saved through a committed preview', async () => {
  fixture.version = 4 // The compatibility path for servers without exact target reads
  vi.mocked(runJob).mockImplementation(
    async (_library, action) =>
      ({
        id: action === 'preview' ? 'prepared' : 'saved',
        receipt: 'r',
        state: 'succeeded',
      }) as Job,
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CatalogMomentTags
        library="synthetic"
        moment={moment}
        names={{ 'tag-a': 'Synthetic one', 'tag-b': 'Synthetic two' }}
      />
    </QueryClientProvider>,
  )
  expect(screen.getByText('Synthetic one')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: '1 more tag: Synthetic two' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
  const added = await screen.findByRole('option', { name: /Synthetic three/ })
  // An assigned tag is listed once, under Selected
  expect(screen.getAllByRole('option', { name: /Synthetic one/ })).toHaveLength(1)
  fireEvent.click(added)
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(2))
  expect(vi.mocked(runJob).mock.calls[0]?.[2]).toEqual({
    action: 'moment_tag',
    moment: 'moment-1',
    target: 'tag-c',
    assigned: true,
    observed: { 'moments/moment-1/$alive': ['seen'] },
  })
  expect(vi.mocked(runJob).mock.calls[1]?.slice(1, 3)).toEqual([
    'commit_preview',
    { job: 'prepared', receipt: 'r' },
  ])
})

function tree() {
  vi.mocked(runJob).mockResolvedValue({ id: 'prepared', receipt: 'r', state: 'succeeded' } as Job)
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <CatalogMomentTags
        library="synthetic"
        moment={moment}
        names={{ 'tag-a': 'Synthetic one', 'tag-b': 'Synthetic two' }}
      />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Add tag' }))
  return screen.findByRole('dialog', { name: 'Moment tags' })
}

test('moment tags fold their children and save a selected child with freshly read guards', async () => {
  const panel = within(await tree())
  expect(
    panel.getByRole('button', { name: /Harbor/ }).querySelectorAll('.pick-guide'),
  ).toHaveLength(1)
  fireEvent.click(panel.getByRole('button', { name: 'Collapse' }))
  expect(panel.queryByRole('button', { name: /Harbor/ })).toBeNull()
  fireEvent.click(panel.getByRole('button', { name: 'Expand' }))
  fireEvent.click(panel.getByRole('button', { name: /Harbor/ }))
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(2))
  expect(replicaRequest).toHaveBeenCalledWith(
    'synthetic',
    '/catalog/moments/moment-1/tags?target=tag-c&limit=1',
    'GET',
    undefined,
  )
  expect(vi.mocked(runJob).mock.calls[0]?.[2]).toEqual({
    action: 'moment_tag',
    moment: 'moment-1',
    target: 'tag-c',
    assigned: true,
    observed: { 'moments/moment-1/$alive': ['seen'] },
  })
})

test('creating a nested tag assigns the created leaf to the moment', async () => {
  fixture.create.mockImplementation((_input, options) => options.onSuccess({ id: 'new-leaf' }))
  const panel = within(await tree())
  fireEvent.change(panel.getByRole('textbox', { name: 'Search tags' }), {
    target: { value: 'Scene/Night' },
  })
  fireEvent.keyDown(panel.getByRole('textbox', { name: 'Search tags' }), { key: 'Enter' })
  await waitFor(() => expect(runJob).toHaveBeenCalledTimes(2))
  expect(fixture.create.mock.calls[0]?.[0].path).toBe('Scene/Night')
  expect(vi.mocked(runJob).mock.calls[0]?.[2]).toMatchObject({ target: 'new-leaf', assigned: true })
})

test('a tree choice requiring conflict review never starts a save', async () => {
  fixture.held = true
  const panel = within(await tree())
  fireEvent.click(panel.getByRole('button', { name: /Harbor/ }))
  expect(await screen.findByRole('alert')).toHaveTextContent('needs conflict review')
  expect(runJob).not.toHaveBeenCalled()
})
