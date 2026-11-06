import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog, CatalogJobError, runJob, type Entity, type Field, type Job } from '../api/catalog'
import { setActiveLibraryId } from '../api/client'
import { CatalogConflictDialog } from './CatalogConflictDialog'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
  runJob: vi.fn(),
}))

const owner = 'asset_bundles/synthetic-bundle'
const unit = (field: string) => `${owner}/${field}`

function field(name: string, value: string | null, candidates: string[], held = true): Field {
  return {
    unit: unit(name),
    value,
    basis: candidates.map((_, index) => `${name}-revision-${index}`),
    candidates: candidates.map((raw, index) => ({
      value: raw,
      revisions: [`${name}-revision-${index}`],
    })),
    held: held ? 'Concurrent alternatives require a complete structural choice' : null,
    components: {},
  }
}

let fields: Record<string, Field>
let scopes: Record<string, string[]>

beforeEach(() => {
  setActiveLibraryId('synthetic-library')
  vi.mocked(runJob).mockReset()
  fields = {
    title: field('title', '"Amber title"', ['"Amber title"', '"Blue title"']),
    rating: field('rating', '3', ['3'], false),
    $alive: field('$alive', 'true', ['true'], false),
  }
  scopes = { [unit('title')]: [unit('title')] }
  vi.mocked(catalog).mockReset()
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/history?unit=')) {
      const target = decodeURIComponent(path.slice('/history?unit='.length))
      return { items: [], next_cursor: null, scope: scopes[target] } as never
    }
    if (path === `/entities/${owner}`)
      return {
        family: 'asset_bundles',
        id: 'synthetic-bundle',
        has_conflicts: true,
        fields,
        observed: {},
        parents: [],
      } satisfies Entity as never
    throw new Error(`Unexpected request ${path}`)
  })
})

function setup() {
  const props = { onClose: vi.fn(), onResolved: vi.fn(), onAdvanced: vi.fn() }
  render(
    <CatalogConflictDialog
      library="synthetic-library"
      bundles={['synthetic-bundle']}
      blocked={false}
      {...props}
    />,
  )
  return props
}

const job = (id: string): Job => ({
  action: 'preview',
  id,
  state: 'succeeded',
  result: { event: `${id}-event` } as Job['result'],
  error: null,
  receipt: `${id}-receipt`,
})

test('a title conflict shows readable versions and commits the displayed choice', async () => {
  const props = setup()
  const dialog = await screen.findByRole('dialog', { name: 'Conflicting Edits' })
  const group = within(dialog).getByRole('group', { name: 'Title' })
  expect(within(group).getAllByRole('radio')).toHaveLength(2)
  expect(within(group).getByText('Amber title')).toBeVisible()
  expect(within(group).getByText('Shown now')).toBeVisible()
  // No stored JSON, unit names or revision identities in the ordinary flow
  expect(dialog.textContent).not.toMatch(/"|asset_bundles|revision|synthetic-bundle/)
  const keep = within(dialog).getByRole('button', { name: 'Keep Selected' })
  expect(keep).toBeDisabled()
  vi.mocked(runJob)
    .mockResolvedValueOnce(job('prepared-job'))
    .mockResolvedValueOnce(job('commit-job'))
  fireEvent.click(within(group).getByRole('radio', { name: /Blue title/ }))
  fireEvent.click(keep)
  await waitFor(() => expect(props.onClose).toHaveBeenCalled())
  expect(runJob).toHaveBeenNthCalledWith(
    1,
    'synthetic-library',
    'preview',
    {
      action: 'choose',
      unit: unit('title'),
      recover: false,
      choices: { [unit('title')]: '"Blue title"' },
      observed: { [unit('title')]: ['title-revision-0', 'title-revision-1'] },
    },
    expect.any(String),
  )
  expect(runJob).toHaveBeenNthCalledWith(
    2,
    'synthetic-library',
    'commit_preview',
    { job: 'prepared-job', receipt: 'prepared-job-receipt' },
    'commit_prepared-job',
  )
  expect(props.onResolved).toHaveBeenCalledOnce()
})

test('notes and ratings render as the inspector shows them', async () => {
  fields.title = field('title', '"Same title"', ['"Same title"'], false)
  fields.notes = field('notes', JSON.stringify(JSON.stringify(['First line', 'Second line'])), [
    JSON.stringify(JSON.stringify(['First line', 'Second line'])),
    JSON.stringify(JSON.stringify(['Other line'])),
  ])
  fields.rating = field('rating', '3', ['3', 'null'])
  scopes = {
    [unit('notes')]: [unit('notes'), unit('rating')],
    [unit('rating')]: [unit('notes'), unit('rating')],
  }
  setup()
  const notes = await screen.findByRole('group', { name: 'Notes' })
  expect(
    within(notes)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['First line', 'Second line', 'Other line'])
  const rating = screen.getByRole('group', { name: 'Rating' })
  expect(within(rating).getByText('3 stars')).toBeVisible()
  expect(within(rating).getByText('No rating')).toBeVisible()
  // One complete scope is one choice, not two
  expect(catalog).toHaveBeenCalledTimes(2)
})

test('a structural conflict leads to the complete review instead of choosing here', async () => {
  fields.$members = field('$members', '[]', ['[]', '[{"file_id":"x"}]'])
  scopes = { [unit('$members')]: [unit('$members')] }
  fields.title = field('title', '"Same title"', ['"Same title"'], false)
  const props = setup()
  const button = await screen.findByRole('button', { name: 'Open Full Review…' })
  expect(screen.getByText('Files and their order')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Keep Selected' })).toBeNull()
  expect(screen.queryByRole('radio')).toBeNull()
  fireEvent.click(button)
  expect(props.onAdvanced).toHaveBeenCalledWith(unit('$members'))
})

test('a lost reply retries the same operation; a stale review reloads the versions', async () => {
  const props = setup()
  const group = await screen.findByRole('group', { name: 'Title' })
  fireEvent.click(within(group).getByRole('radio', { name: /Amber title/ }))
  vi.mocked(runJob).mockRejectedValueOnce(new Error('Network unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'Keep Selected' }))
  expect(await screen.findByText('Network unavailable')).toBeVisible()
  const first = vi.mocked(runJob).mock.calls[0]![3]
  vi.mocked(runJob).mockRejectedValueOnce(
    new CatalogJobError('Conflict review is stale; review the current alternatives'),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Keep Selected' }))
  expect(
    await screen.findByText(
      'These versions changed while this was open. The latest versions are shown.',
    ),
  ).toBeVisible()
  expect(vi.mocked(runJob).mock.calls[1]![3]).toBe(first)
  await waitFor(() =>
    expect(
      vi.mocked(catalog).mock.calls.filter(([, path]) => path.startsWith('/history')),
    ).toHaveLength(2),
  )
  // A refused intent is not retried under the identity the server already rejected
  await waitFor(() => expect(screen.getByRole('button', { name: 'Keep Selected' })).toBeEnabled())
  vi.mocked(runJob)
    .mockResolvedValueOnce(job('prepared-again'))
    .mockResolvedValueOnce(job('commit-again'))
  fireEvent.click(screen.getByRole('button', { name: 'Keep Selected' }))
  await waitFor(() => expect(props.onClose).toHaveBeenCalled())
  expect(vi.mocked(runJob).mock.calls[2]![3]).not.toBe(first)
})

test('Escape closes the review without saving', async () => {
  const props = setup()
  await screen.findByRole('group', { name: 'Title' })
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(props.onClose).toHaveBeenCalled()
  expect(runJob).not.toHaveBeenCalled()
})
