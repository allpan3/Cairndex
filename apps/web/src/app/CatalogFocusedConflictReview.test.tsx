import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog, runJob, type Entity, type Field, type Job } from '../api/catalog'
import { draftKey } from '../api/replicas'
import { setActiveLibraryId } from '../api/client'
import { CatalogFocusedConflictReview } from './CatalogFocusedConflictReview'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
  runJob: vi.fn(),
}))

function field(unit: string, value: string | null, candidates: string[], held = true): Field {
  return {
    unit,
    value,
    basis: candidates.map((_, index) => `${unit}-rev-${index}`),
    candidates: candidates.map((raw, index) => ({
      value: raw,
      revisions: [`${unit}-rev-${index}`],
    })),
    held: held ? 'Concurrent alternatives require a complete structural choice' : null,
    components: {},
  }
}

beforeEach(() => {
  localStorage.clear()
  setActiveLibraryId('synthetic-library')
  vi.mocked(catalog).mockReset()
  vi.mocked(runJob).mockReset()
})

test('Companion held-unit resolution renders human-readable labels, preserves causal recovery, and returns to browser context', async () => {
  let resolved = false
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/drafts')) return { items: [] } as never
    if (path === '/entities/asset_file_tags/file-alpha~tag-blue') {
      return {
        family: 'asset_file_tags',
        id: 'file-alpha~tag-blue',
        has_conflicts: !resolved,
        fields: {
          $alive: field('asset_file_tags/file-alpha~tag-blue/$alive', 'true', ['true'], !resolved),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path === '/entities/tags/tag-blue') {
      return {
        family: 'tags',
        id: 'tag-blue',
        has_conflicts: !resolved,
        fields: {
          $alive: resolved
            ? field('tags/tag-blue/$alive', 'true', ['true'], false)
            : field('tags/tag-blue/$alive', 'false', ['false', 'true'], true),
          name: field('tags/tag-blue/name', '"Blue"', ['"Blue"'], false),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path === '/entities/asset_files/file-alpha') {
      return {
        family: 'asset_files',
        id: 'file-alpha',
        has_conflicts: false,
        fields: {
          $alive: field('asset_files/file-alpha/$alive', 'true', ['true'], false),
          relative_path: field(
            'asset_files/file-alpha/relative_path',
            '"clips/alpha.png"',
            ['"clips/alpha.png"'],
            false,
          ),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path.startsWith('/history?unit=')) {
      return {
        items: [],
        next_cursor: null,
        scope: ['asset_file_tags/file-alpha~tag-blue/$alive', 'tags/tag-blue/$alive'],
      } as never
    }
    throw new Error(`Unexpected request ${path}`)
  })

  const onBack = vi.fn()
  const onOpenMetadataReview = vi.fn()
  const onResolved = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <CatalogFocusedConflictReview
        library="synthetic-library"
        editor="synthetic-editor"
        unit="asset_file_tags/file-alpha~tag-blue/$alive"
        blocked={false}
        returnLabel="Bundle Album"
        onBack={onBack}
        onOpenMetadataReview={onOpenMetadataReview}
        onResolved={onResolved}
      />
    </QueryClientProvider>,
  )

  expect(
    await screen.findByRole('heading', { name: 'Conflict Review · Tag “Blue” on “alpha.png”' }),
  ).toBeVisible()
  // No generic catalog family switcher or unrelated object list
  expect(screen.queryByRole('navigation', { name: 'Catalog families' })).toBeNull()

  const reviewRegion = screen.getByRole('region', { name: 'Complete conflict review' })
  const edgeGroup = within(reviewRegion).getByRole('group', { name: 'Tag “Blue” on “alpha.png”' })
  const tagGroup = within(reviewRegion).getByRole('group', { name: 'Tag “Blue”' })
  expect(within(edgeGroup).getByText('Assigned')).toBeVisible()
  expect(within(tagGroup).getByText('Keep deleted')).toBeVisible()
  expect(within(tagGroup).getByText('Keep in library')).toBeVisible()

  // Selecting Keep in library highlights explicit recovery safeguard
  fireEvent.click(within(tagGroup).getByRole('radio', { name: /Keep in library/ }))
  expect(
    within(reviewRegion).getByText(/required when keeping an item that was deleted/i),
  ).toBeVisible()
  fireEvent.click(
    within(reviewRegion).getByRole('checkbox', {
      name: /Explicitly restore a deleted identity/i,
    }),
  )

  vi.mocked(runJob)
    .mockResolvedValueOnce({
      id: 'preview-1',
      action: 'preview',
      state: 'succeeded',
      receipt: 'receipt-1',
      error: null,
      result: {
        changes: [
          {
            unit: 'asset_file_tags/file-alpha~tag-blue/$alive',
            value: 'true',
            basis: ['asset_file_tags/file-alpha~tag-blue/$alive-rev-0'],
          },
          {
            unit: 'tags/tag-blue/$alive',
            value: 'true',
            basis: ['tags/tag-blue/$alive-rev-0', 'tags/tag-blue/$alive-rev-1'],
          },
        ],
      },
    } as unknown as Job)
    .mockResolvedValueOnce({
      id: 'commit-1',
      action: 'commit_preview',
      state: 'succeeded',
      receipt: null,
      error: null,
      result: { event: 'event-1' } as Job['result'],
    })

  fireEvent.click(within(reviewRegion).getByRole('button', { name: 'Prepare choice' }))
  const prepared = await screen.findByRole('region', { name: 'Prepared catalog operation' })
  expect(runJob).toHaveBeenNthCalledWith(
    1,
    'synthetic-library',
    'preview',
    expect.objectContaining({
      action: 'choose',
      recover: true,
      choices: {
        'asset_file_tags/file-alpha~tag-blue/$alive': 'true',
        'tags/tag-blue/$alive': 'true',
      },
    }),
    expect.any(String),
  )

  resolved = true
  fireEvent.click(within(prepared).getByRole('button', { name: 'Apply reviewed operation' }))
  await waitFor(() => expect(onResolved).toHaveBeenCalledOnce())
  await waitFor(() => expect(onBack).toHaveBeenCalledOnce())
})

test('Bundle $members conflict resolves file names and supports Open in Metadata Review escape hatch', async () => {
  // A deletion previously prepared in Metadata Review belongs to the full editor.
  localStorage.setItem(
    draftKey('synthetic-library', 'preview/asset_bundles/bundle-1', 'synthetic-editor'),
    JSON.stringify({ id: 'prior', revision: 1, body: { job: 'prior-deletion' } }),
  )
  vi.mocked(catalog).mockImplementation(async (_library, path) => {
    if (path.startsWith('/drafts')) return { items: [] } as never
    if (path === '/entities/asset_bundles/bundle-1') {
      return {
        family: 'asset_bundles',
        id: 'bundle-1',
        has_conflicts: true,
        fields: {
          $alive: field('asset_bundles/bundle-1/$alive', 'true', ['true'], false),
          title: field(
            'asset_bundles/bundle-1/title',
            '"Harbor Scenes"',
            ['"Harbor Scenes"'],
            false,
          ),
          $members: field(
            'asset_bundles/bundle-1/$members',
            '[{"family":"asset_files","id":"f1"},{"family":"asset_files","id":"f2"}]',
            [
              '[{"family":"asset_files","id":"f1"},{"family":"asset_files","id":"f2"}]',
              '[{"family":"asset_files","id":"f2"},{"family":"asset_files","id":"f1"}]',
            ],
          ),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path === '/entities/asset_files/f1') {
      return {
        family: 'asset_files',
        id: 'f1',
        has_conflicts: false,
        fields: {
          relative_path: field(
            'asset_files/f1/relative_path',
            '"harbor/dawn.jpg"',
            ['"harbor/dawn.jpg"'],
            false,
          ),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path === '/entities/asset_files/f2') {
      return {
        family: 'asset_files',
        id: 'f2',
        has_conflicts: false,
        fields: {
          relative_path: field(
            'asset_files/f2/relative_path',
            '"harbor/dusk.jpg"',
            ['"harbor/dusk.jpg"'],
            false,
          ),
        },
        observed: {},
        parents: [],
      } satisfies Entity as never
    }
    if (path.startsWith('/history?unit=')) {
      return {
        items: [],
        next_cursor: null,
        scope: ['asset_bundles/bundle-1/$members'],
      } as never
    }
    throw new Error(`Unexpected request ${path}`)
  })

  const onBack = vi.fn()
  const onOpenMetadataReview = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  render(
    <QueryClientProvider client={client}>
      <CatalogFocusedConflictReview
        library="synthetic-library"
        editor="synthetic-editor"
        unit="asset_bundles/bundle-1/$members"
        blocked={false}
        returnLabel="Bundle Browser"
        onBack={onBack}
        onOpenMetadataReview={onOpenMetadataReview}
        onResolved={vi.fn()}
      />
    </QueryClientProvider>,
  )

  expect(
    await screen.findByRole('heading', { name: 'Conflict Review · Harbor Scenes' }),
  ).toBeVisible()
  const membersGroup = screen.getByRole('group', { name: 'Files and order in “Harbor Scenes”' })
  expect(within(membersGroup).getAllByText('dawn.jpg')).toHaveLength(2)
  expect(within(membersGroup).getAllByText('dusk.jpg')).toHaveLength(2)

  expect(catalog).not.toHaveBeenCalledWith('synthetic-library', '/jobs/prior-deletion')
  expect(screen.queryByRole('region', { name: 'Prepared catalog operation' })).toBeNull()

  // Compose a replacement remains available inside collapsed details
  expect(within(membersGroup).getByText('Compose a replacement')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Open in Metadata Review' }))
  expect(onOpenMetadataReview).toHaveBeenCalledWith(
    'asset_bundles',
    'bundle-1',
    'asset_bundles/bundle-1/$members',
  )
})

test('a failed entity read offers retry without claiming the conflict cleared', async () => {
  vi.mocked(catalog).mockRejectedValue(new Error('Catalog is offline'))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <CatalogFocusedConflictReview
        library="synthetic-library"
        editor="synthetic-editor"
        unit="asset_bundles/bundle-1/$members"
        blocked={false}
        returnLabel="Bundle Browser"
        onBack={vi.fn()}
        onOpenMetadataReview={vi.fn()}
        onResolved={vi.fn()}
      />
    </QueryClientProvider>,
  )
  expect(await screen.findByRole('alert')).toHaveTextContent('Catalog is offline')
  expect(screen.getByRole('button', { name: 'Try Again' })).toBeEnabled()
  expect(screen.queryByText('No conflicts remain')).toBeNull()
})
