import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { type CollectionRead, type GroupingProposal, setActiveLibraryId } from '../api/client'
import { GroupingReview } from './GroupingReview'

const PROPOSALS: GroupingProposal[] = [
  {
    id: 'collection1',
    kind: 'container',
    title: 'Movies',
    directory: 'Movies',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.9,
    reason: 'holds related bundles',
    files: [],
  },
  {
    id: 'proposal1',
    kind: 'bundle',
    title: 'SRCV-005 - cut',
    directory: 'SRCV-005',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.95,
    reason: 'same filename stem',
    files: [
      {
        asset_file_id: 'file1',
        relative_path: 'SRCV-005/SRCV-005.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
      {
        asset_file_id: 'file2',
        relative_path: 'SRCV-005/SRCV-005.mp3',
        proposed_role: 'attachment',
        sequence: 1,
      },
      {
        asset_file_id: 'file3',
        relative_path: 'SRCV-005/cover.jpg',
        proposed_role: 'cover',
        sequence: 2,
      },
    ],
  },
  {
    id: 'proposal2',
    kind: 'bundle',
    title: 'Second bundle',
    directory: 'Second',
    parent_proposal_id: null,
    target_bundle_id: null,
    target_bundle_title: null,
    create_new_bundle: false,
    target_collection_id: null,
    is_collection_context: false,
    confidence: 0.8,
    reason: 'same folder',
    files: [
      {
        asset_file_id: 'file4',
        relative_path: 'Second/second.mp4',
        proposed_role: 'primary_video',
        sequence: 0,
      },
    ],
  },
]

const ADDITION: GroupingProposal = {
  id: 'addition1',
  kind: 'bundle',
  title: 'Surf On The Ridge - 4K',
  directory: 'Western/Nora Vance',
  parent_proposal_id: null,
  target_bundle_id: 'existing1',
  target_bundle_title: 'Sky, Sand, Sea & Salt - 4K',
  create_new_bundle: false,
  target_collection_id: null,
  is_collection_context: false,
  confidence: 0.8,
  reason: 'add 3 new file(s) to existing bundle',
  files: [
    {
      asset_file_id: 'new-video',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.mp4',
      proposed_role: 'video_part',
      sequence: 0,
    },
    // A second video, so this row *could* divide — which is what makes the
    // "additions offer no collection override" test prove the addition rule
    // rather than pass because the row was indivisible anyway.
    {
      asset_file_id: 'new-video-2',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K alt.mp4',
      proposed_role: 'alternate_version',
      sequence: 1,
    },
    {
      asset_file_id: 'new-cover',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.jpg',
      proposed_role: 'image',
      sequence: 2,
    },
  ],
}

/** A bundle that can genuinely divide: two video subjects in one folder.
 *
 * Turning a *single*-subject bundle into a collection is refused (it would wrap
 * it in a collection of one identical bundle), so the conversion tests need a
 * row with something to divide. */
const DIVISIBLE: GroupingProposal = {
  id: 'divisible1',
  kind: 'bundle',
  title: 'Two Subjects',
  directory: 'Two',
  parent_proposal_id: null,
  target_bundle_id: null,
  target_bundle_title: null,
  create_new_bundle: false,
  target_collection_id: null,
  is_collection_context: false,
  confidence: 0.7,
  reason: '2 unrelated files',
  files: [
    {
      asset_file_id: 'two-a',
      relative_path: 'Two/alpha.mp4',
      proposed_role: 'primary_video',
      sequence: 0,
    },
    {
      asset_file_id: 'two-b',
      relative_path: 'Two/beta.mp4',
      proposed_role: 'alternate_version',
      sequence: 1,
    },
  ],
}

const NESTED_PROPOSALS: GroupingProposal[] = [
  {
    ...PROPOSALS[0]!,
    id: 'outer-collection',
    title: 'Library',
    directory: 'Library',
  },
  {
    ...PROPOSALS[0]!,
    id: 'inner-collection',
    title: 'Series',
    directory: 'Library/Series',
    parent_proposal_id: 'outer-collection',
  },
  {
    ...PROPOSALS[1]!,
    id: 'nested-one',
    title: 'Episode One',
    directory: 'Library/Series/Episode One',
    parent_proposal_id: 'inner-collection',
    files: [
      {
        asset_file_id: 'episode-one-file',
        relative_path: 'Library/Series/Episode One/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
  {
    ...PROPOSALS[1]!,
    id: 'nested-two',
    title: 'Episode Two',
    directory: 'Library/Series/Episode Two',
    parent_proposal_id: 'inner-collection',
    files: [
      {
        asset_file_id: 'episode-two-file',
        relative_path: 'Library/Series/Episode Two/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
  {
    ...PROPOSALS[2]!,
    id: 'outer-sibling',
    title: 'Feature',
    directory: 'Library/Feature',
    parent_proposal_id: 'outer-collection',
    files: [
      {
        asset_file_id: 'feature-file',
        relative_path: 'Library/Feature/video.mp4',
        proposed_role: 'video_part',
        sequence: 0,
      },
    ],
  },
]

const CURRENT_COLLECTIONS: CollectionRead[] = [
  {
    id: 'current-archive',
    parent_id: null,
    name: 'Current Archive',
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
  {
    id: 'current-series',
    parent_id: 'current-archive',
    name: 'Current Series',
    note: null,
    cover_bundle_id: null,
    sort_order: 0,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
  {
    id: 'current-reference',
    parent_id: null,
    name: 'Reference',
    note: null,
    cover_bundle_id: null,
    sort_order: 1,
    created_at: '2026-08-09T00:00:00Z',
    updated_at: '2026-08-09T00:00:00Z',
    version: 1,
  },
]

/** Install a mutable grouping-plan API mock and return its fetch spy. */
function mockGroupingApi(
  initialProposals: GroupingProposal[] = PROPOSALS,
  collections: CollectionRead[] = CURRENT_COLLECTIONS,
  // Lets a test hand back a mode this build does not know, which is how the
  // stem index arithmetic went wrong.
  initialStemModes: Record<string, string> = {},
) {
  let proposals = structuredClone(initialProposals)
  let planId = 'plan1'
  let stemModes: Record<string, string> = { ...initialStemModes }
  return vi.fn((url: string, init?: RequestInit) => {
    let body: unknown
    if (url.includes('/collections?')) {
      body = { items: collections, next_cursor: null }
    } else if (url.endsWith('/grouping/plans') && init?.method === 'POST') {
      planId = 'plan2'
      stemModes = (
        JSON.parse(init.body as string) as {
          stem_modes: Record<string, 'narrow' | 'balanced' | 'wide'>
        }
      ).stem_modes
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.endsWith('/grouping/plans')) {
      body = [
        {
          id: planId,
          status: 'open',
          rule_version: 5,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ]
    } else if (url.endsWith(`/grouping/plans/${planId}`)) {
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/destination$/) && init?.method === 'PUT') {
      const proposalId = url.split('/').at(-2)!
      const createNewBundle = (JSON.parse(init.body as string) as { create_new_bundle: boolean })
        .create_new_bundle
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId
          ? {
              ...proposal,
              create_new_bundle: createNewBundle,
              files: proposal.files.map((file) => ({
                ...file,
                proposed_role: createNewBundle
                  ? file.asset_file_id === 'new-cover'
                    ? ('cover' as const)
                    : ('primary_video' as const)
                  : file.asset_file_id === 'new-cover'
                    ? ('image' as const)
                    : ('video_part' as const),
              })),
            }
          : proposal,
      )
      body = proposals.find((proposal) => proposal.id === proposalId)
    } else if (url.match(/\/proposals\/[^/]+$/) && init?.method === 'PATCH') {
      const proposalId = url.split('/').pop()!
      const title = (JSON.parse(init.body as string) as { title: string }).title
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId ? { ...proposal, title } : proposal,
      )
      body = proposals.find((proposal) => proposal.id === proposalId)
    } else if (url.match(/\/proposals\/[^/]+\/files\/[^/]+\/move$/)) {
      const parts = url.split('/')
      const sourceId = parts.at(-4)!
      const assetFileId = parts.at(-2)!
      const payload = JSON.parse(init?.body as string) as {
        target_proposal_id: string
        target_index: number
      }
      const source = proposals.find((proposal) => proposal.id === sourceId)!
      const target = proposals.find((proposal) => proposal.id === payload.target_proposal_id)!
      const sourceIndex = source.files.findIndex((file) => file.asset_file_id === assetFileId)
      const sourceFiles = [...source.files]
      const [moving] = sourceFiles.splice(sourceIndex, 1)
      if (!moving) throw new Error('missing mock proposal file')
      const targetFiles = source.id === target.id ? sourceFiles : [...target.files]
      const targetIndex =
        source.id === target.id && sourceIndex < payload.target_index
          ? payload.target_index - 1
          : payload.target_index
      targetFiles.splice(targetIndex, 0, moving)
      const updated = [
        {
          ...source,
          files: (source.id === target.id ? targetFiles : sourceFiles).map((file, sequence) => ({
            ...file,
            sequence,
          })),
        },
        ...(source.id === target.id
          ? []
          : [{ ...target, files: targetFiles.map((file, sequence) => ({ ...file, sequence })) }]),
      ]
      proposals = proposals.map(
        (proposal) => updated.find((item) => item.id === proposal.id) ?? proposal,
      )
      body = updated
    } else if (url.match(/\/stem-modes$/) && init?.method === 'PUT') {
      const { directory, mode } = JSON.parse(init.body as string) as {
        directory: string
        mode: 'narrow' | 'balanced' | 'wide'
      }
      if (mode === 'balanced') delete stemModes[directory]
      else stemModes[directory] = mode
      // In place: only the adjusted directory's rows are replaced (new ids).
      proposals = proposals.map((proposal) =>
        proposal.directory === directory ? { ...proposal, id: `${proposal.id}-regen` } : proposal,
      )
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/kind$/) && init?.method === 'PUT') {
      // The server returns the whole plan, because a conversion adds or removes
      // sibling proposals rather than editing one in place.
      const proposalId = url.split('/').at(-2)!
      const kind = (JSON.parse(init.body as string) as { kind: 'bundle' | 'container' }).kind
      const source = proposals.find((proposal) => proposal.id === proposalId)!
      const children: GroupingProposal[] =
        kind === 'container'
          ? source.files.map((file, index) => ({
              ...source,
              id: `${proposalId}-child${index}`,
              kind: 'bundle' as const,
              title: file.relative_path.split('/').pop()!,
              parent_proposal_id: proposalId,
              files: [{ ...file, sequence: 0 }],
            }))
          : []
      proposals = [
        ...proposals.map((proposal) =>
          proposal.id === proposalId
            ? { ...proposal, kind, files: kind === 'container' ? [] : proposal.files }
            : proposal,
        ),
        ...children,
      ]
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.match(/\/proposals\/[^/]+\/parent$/) && init?.method === 'PUT') {
      const proposalId = url.split('/').at(-2)!
      const payload = JSON.parse(init.body as string) as {
        parent_proposal_id: string | null
        target_collection_id: string | null
      }
      let parentProposalId = payload.parent_proposal_id
      if (payload.target_collection_id) {
        const byCollectionId = new Map(collections.map((collection) => [collection.id, collection]))
        const path: CollectionRead[] = []
        let collection = byCollectionId.get(payload.target_collection_id)
        while (collection) {
          path.push(collection)
          collection = collection.parent_id ? byCollectionId.get(collection.parent_id) : undefined
        }
        let contextParentId: string | null = null
        for (const item of path.reverse()) {
          const existing = proposals.find((proposal) => proposal.target_collection_id === item.id)
          const context: GroupingProposal = existing ?? {
            id: `context-${item.id}`,
            kind: 'container',
            title: item.name,
            directory: `@existing-collection/${item.id}`,
            parent_proposal_id: contextParentId,
            target_bundle_id: null,
            target_bundle_title: null,
            create_new_bundle: false,
            target_collection_id: item.id,
            is_collection_context: true,
            confidence: 1,
            reason: 'existing collection',
            files: [],
          }
          context.parent_proposal_id = contextParentId
          if (!existing) proposals = [...proposals, context]
          contextParentId = context.id
        }
        parentProposalId = contextParentId
      }
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId
          ? { ...proposal, parent_proposal_id: parentProposalId }
          : proposal,
      )
      body = {
        id: planId,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
    } else if (url.endsWith(`/grouping/plans/${planId}/apply`) && init?.method === 'POST') {
      body = {
        bundles_confirmed: 2,
        bundles_removed: 0,
        collections_created: 1,
        bundles_added_to_collections: 2,
        files_added_to_bundles: 0,
        subtitles_linked: 0,
        conflicts: [],
      }
    } else {
      body = {}
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
  })
}

/** Render grouping review with isolated query state. */
function renderReview() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupingReview initialPlanId="plan1" onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

beforeEach(() => setActiveLibraryId('lib1'))

afterEach(() => {
  cleanup()
  setActiveLibraryId(null)
  vi.restoreAllMocks()
})

test('folds and restores descendant proposals under a collection', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const innerTitle = await screen.findByRole('button', {
    name: 'Rename collection suggestion Series',
  })
  const collapse = screen.getByRole('button', {
    name: 'Collapse collection suggestion Library',
  })
  expect(collapse).toHaveAttribute('aria-expanded', 'true')
  expect(innerTitle).toBeVisible()

  fireEvent.click(collapse)

  expect(innerTitle).not.toBeVisible()
  expect(screen.getByText('3 bundles selected')).toBeInTheDocument()
  const expand = screen.getByRole('button', { name: 'Expand collection suggestion Library' })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(expand)
  expect(innerTitle).toBeVisible()
})

// Fold state is per row, not per content. Two file-less bundles hash to the same
// content key, and so does a bundle converted to a collection under a container
// for the same directory — a shared fold key collapsed both rows at once and hid
// the row that was clicked inside its own collapsed ancestor.
test('two suggestions with identical content fold independently', async () => {
  const emptied: GroupingProposal[] = [
    { ...PROPOSALS[1]!, id: 'empty-a', title: 'Emptied A', files: [] },
    { ...PROPOSALS[1]!, id: 'empty-b', title: 'Emptied B', files: [] },
  ]
  vi.stubGlobal('fetch', mockGroupingApi(emptied))
  renderReview()

  const first = await screen.findByRole('button', {
    name: 'Expand files in bundle suggestion Emptied A',
  })
  const second = screen.getByRole('button', {
    name: 'Expand files in bundle suggestion Emptied B',
  })
  expect(first).toHaveAttribute('aria-expanded', 'false')
  expect(second).toHaveAttribute('aria-expanded', 'false')

  fireEvent.click(first)

  expect(
    screen.getByRole('button', { name: 'Collapse files in bundle suggestion Emptied A' }),
  ).toHaveAttribute('aria-expanded', 'true')
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Emptied B' }),
  ).toHaveAttribute('aria-expanded', 'false')
})

test('folds and restores the file list under a bundle', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  // Closed by default: the row's summary carries the shape, and the list is one
  // click away when it does not.
  const expand = await screen.findByRole('button', {
    name: 'Expand files in bundle suggestion SRCV-005 - cut',
  })
  expect(expand).toHaveAttribute('aria-expanded', 'false')
  fireEvent.dragStart(expand, { dataTransfer: dragData() })
  expect(review.container.querySelector('.grp-root-drop')).not.toBeInTheDocument()

  fireEvent.click(expand)

  const files = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  expect(files).toBeVisible()
  const collapse = screen.getByRole('button', {
    name: 'Collapse files in bundle suggestion SRCV-005 - cut',
  })
  expect(collapse).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(collapse)
  expect(files).not.toBeVisible()
})

test('collapses and expands every collection and bundle', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  fireEvent.click(await screen.findByRole('button', { name: 'Show files' }))
  const files = screen.getByRole('list', { name: 'Files in Episode One' })
  fireEvent.click(screen.getByRole('button', { name: 'Hide files' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))

  expect(files).not.toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Expand collection suggestion Library' }))
  fireEvent.click(screen.getByRole('button', { name: 'Expand collection suggestion Series' }))
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Episode One' }),
  ).toBeVisible()
  // Collapse/Expand all governs collections; file lists have their own toggle.
  expect(files).not.toBeVisible()

  fireEvent.click(screen.getByRole('button', { name: 'Show files' }))

  expect(files).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Collapse collection suggestion Library' }),
  ).toBeVisible()
  expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled()
})

test('double-click renames a bundle suggestion and persists it', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const title = await screen.findByRole('button', {
    name: 'Rename bundle suggestion SRCV-005 - cut',
  })
  fireEvent.doubleClick(title)
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'SRCV-005' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005' })
  const patchCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1') && init?.method === 'PATCH',
  )
  expect(patchCall?.[1]).toMatchObject({ body: JSON.stringify({ title: 'SRCV-005' }) })
})

test('title editor mirrors its live text instead of shrinking to a fixed width', async () => {
  const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus')
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  expect(input.tagName).toBe('TEXTAREA')
  expect(focus).toHaveBeenCalledWith({ preventScroll: true })
  const mirror = input.closest('.grp-title-editor')
  expect(mirror).toHaveAttribute('data-value', 'SRCV-005 - cut')
  fireEvent.change(input, { target: { value: 'SRCV-005 - a substantially longer cut title' } })
  expect(mirror).toHaveAttribute('data-value', 'SRCV-005 - a substantially longer cut title')
  expect(review.container.querySelectorAll('.grp-title-input')).toHaveLength(1)
})

test('keeps suggestion reasons without rendering numeric confidence badges', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  const review = renderReview()

  expect(await screen.findByText('holds related bundles')).toBeInTheDocument()
  // A bundle row states what it contains rather than why it was grouped; the
  // reason only earns a line when the suggester is unsure (see the filter test).
  expect(screen.getByText('3 files · video, image')).toBeInTheDocument()
  expect(screen.queryByText('same filename stem')).not.toBeInTheDocument()
  // A worded band, never a raw score — the percentages were rejected as noise.
  expect(review.container.querySelectorAll('.grp-conf')).not.toHaveLength(0)
  expect(review.container.textContent).not.toMatch(/\d+(\.\d+)?%/)
  expect(screen.queryByText('90%')).not.toBeInTheDocument()
  expect(screen.queryByText('95%')).not.toBeInTheDocument()
})

test('switches one addition proposal to a renameable new bundle and back', async () => {
  const fetchMock = mockGroupingApi([ADDITION])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const checkbox = await screen.findByRole('checkbox', {
    name: 'Accept Surf On The Ridge - 4K',
  })
  expect(checkbox).toBeChecked()
  expect(screen.getByText('Add to Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
  expect(screen.queryByText('➕')).not.toBeInTheDocument()
  expect(screen.getByText('3 new files')).toBeInTheDocument()
  expect(screen.queryByText('Create new bundle instead')).not.toBeInTheDocument()
  // The menu item names the change it makes, so its label *is* the state.
  fireEvent.click(findRowAction('Create a new bundle from these files'))

  await waitFor(() => expect(screen.getByText('3 files')).toBeInTheDocument())
  const addToExisting = findRowAction('Add these files to “Sky, Sand, Sea & Salt - 4K” instead')
  expect(addToExisting).toHaveTextContent('Add these files to “Sky, Sand, Sea & Salt - 4K” instead')
  expect(screen.getByText('3 files')).toBeInTheDocument()
  expect(screen.queryByText('manual')).not.toBeInTheDocument()
  expect(screen.queryByText('create 3 files as a new bundle')).not.toBeInTheDocument()
  expect(checkbox).toBeChecked()
  fireEvent.doubleClick(
    screen.getByRole('button', { name: 'Rename bundle suggestion Surf On The Ridge - 4K' }),
  )
  expect(addToExisting).toBeInTheDocument()
  expect(addToExisting).toBeDisabled()
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'Separate Feature' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByRole('button', { name: 'Rename bundle suggestion Separate Feature' })
  expect(addToExisting).toBeEnabled()

  fireEvent.click(findRowAction('Add these files to “Sky, Sand, Sea & Salt - 4K” instead'))
  await screen.findByText('Add to Sky, Sand, Sea & Salt - 4K')
  fireEvent.click(findRowAction('Create a new bundle from these files'))
  await screen.findByRole('button', { name: 'Rename bundle suggestion Separate Feature' })

  const destinationCalls = fetchMock.mock.calls.filter(([url]) => url.endsWith('/destination'))
  expect(destinationCalls.map(([, init]) => init?.body)).toEqual([
    JSON.stringify({ create_new_bundle: true }),
    JSON.stringify({ create_new_bundle: false }),
    JSON.stringify({ create_new_bundle: true }),
  ])
})

test('uses the legacy proposal title when the target snapshot title is absent', async () => {
  vi.stubGlobal(
    'fetch',
    mockGroupingApi([{ ...ADDITION, title: 'Legacy Target', target_bundle_title: null }]),
  )
  renderReview()

  expect(await screen.findByText('Add to Legacy Target')).toBeInTheDocument()
  fireEvent.click(findRowAction('Create a new bundle from these files'))
  await waitFor(() => expect(screen.queryByText('Add to Legacy Target')).toBeNull())
  expect(findRowAction('Add these files to “Legacy Target” instead')).toBeInTheDocument()
})

test('disables destination actions while saving and surfaces a switch error', async () => {
  const normalFetch = mockGroupingApi([ADDITION])
  let finishDestination: (() => void) | undefined
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('/destination')) {
      return new Promise<unknown>((resolve) => {
        finishDestination = () =>
          resolve({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ message: 'Existing bundle disappeared' }),
          })
      })
    }
    return normalFetch(url, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await findRowActionAsync('Create a new bundle from these files'))
  // Everything that edits the plan is gated on the same in-flight flag, so
  // Accept is the stable signal that the switch is saving — and re-opening a
  // menu inside a retry callback would fire clicks on every poll.
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept / })).toBeDisabled())
  expect(findRowAction('Create a new bundle from these files')).toBeDisabled()
  finishDestination?.()

  await screen.findByText('Existing bundle disappeared')
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept / })).toBeEnabled())
  expect(findRowAction('Create a new bundle from these files')).toBeEnabled()
  expect(screen.getByText('Add to Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
})

test('regenerating suggestions keeps returned candidates visible immediately', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  await screen.findByText('SRCV-005 - cut')
  fireEvent.click(screen.getByRole('button', { name: 'Suggest grouping' }))

  await screen.findByText('Suggestions generated from the current library state.')
  expect(screen.getByText('SRCV-005 - cut')).toBeInTheDocument()
  expect(
    screen.queryByText('Nothing to group — there are no unbundled files awaiting suggestions.'),
  ).not.toBeInTheDocument()
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => url.endsWith('/grouping/plans') && init?.method === 'POST',
    ),
  ).toBe(true)
})

test('widens one folder in place and keeps the mode', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await findRowActionAsync('Merge SRCV-005 into fewer bundles'))

  await screen.findByText('SRCV-005 now uses wide stem matching.')
  expect(screen.getByText('SRCV-005 - cut')).toBeInTheDocument()
  // Already at the widest setting, so the item stays but cannot be reached again.
  expect(findRowAction('Merge SRCV-005 into fewer bundles')).toBeDisabled()
  // One directory's mode, sent to the in-place endpoint — no plan regeneration.
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/stem-modes') && init?.method === 'PUT',
  )
  expect(put?.[1]).toMatchObject({
    body: JSON.stringify({ directory: 'SRCV-005', mode: 'wide' }),
  })
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) => url.endsWith('/grouping/plans') && init?.method === 'POST',
    ),
  ).toBe(false)
})

test('places a folder stem control on the deepest matching container row', async () => {
  const outer: GroupingProposal = { ...PROPOSALS[0]!, title: 'Western', directory: 'Western' }
  const inner: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'collection2',
    title: 'Nora Vance',
    directory: 'Western/Nora Vance',
    parent_proposal_id: outer.id,
  }
  // File paths must agree with `directory`: the stem control is placed from where
  // a row's files actually live, so a fixture whose paths point elsewhere would
  // read as a hand-merged cross-folder row and (correctly) get no control.
  const bundle: GroupingProposal = {
    ...PROPOSALS[1]!,
    directory: 'Western/Nora Vance',
    parent_proposal_id: inner.id,
    files: PROPOSALS[1]!.files.map((file) => ({
      ...file,
      relative_path: `Western/Nora Vance/${file.relative_path.split('/').pop()}`,
    })),
  }
  vi.stubGlobal('fetch', mockGroupingApi([outer, inner, bundle]))
  renderReview()

  await screen.findByRole('button', { name: 'Rename collection suggestion Western' })

  // The folder's split/merge actions belong to the deepest row that speaks for
  // it, and to that row only.
  const folderAction = 'Merge Western/Nora Vance into fewer bundles'
  expect(queryRowAction(folderAction, 'collection suggestion Western')).toBeNull()
  expect(findRowAction(folderAction, 'collection suggestion Nora Vance')).toBeInTheDocument()
})

test('Escape cancels a bundle suggestion rename', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.change(input, { target: { value: 'Do not save' } })
  fireEvent.keyDown(input, { key: 'Escape' })

  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
    ).toBeInTheDocument(),
  )
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false)
})

test('double-click renames a collection suggestion and persists it', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.doubleClick(
    await screen.findByRole('button', { name: 'Rename collection suggestion Movies' }),
  )
  const input = screen.getByRole('textbox', { name: 'Collection suggestion title' })
  fireEvent.change(input, { target: { value: 'Films' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  await screen.findByRole('button', { name: 'Rename collection suggestion Films' })
  const patchCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/collection1') && init?.method === 'PATCH',
  )
  expect(patchCall?.[1]).toMatchObject({ body: JSON.stringify({ title: 'Films' }) })
})

/** Create the minimal mutable DataTransfer shape used by drag handlers. */
function dragData() {
  return { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn() }
}

/** The row element a drag now starts from.
 *
 * The ⠿ handles are gone: a bundle row and a file row are each draggable in
 * their entirety, which is how the file rows already behaved. */
function fileRow(name: string): HTMLElement {
  const row = screen.getByText(name).closest('.grp-file')
  if (!row) throw new Error(`missing file row for ${name}`)
  return row as HTMLElement
}

function bundleRow(title: string): HTMLElement {
  const row = screen.getByText(title).closest('.grp-row--bundle')
  if (!row) throw new Error(`missing bundle row for ${title}`)
  return row as HTMLElement
}

test('drags proposal files to reorder within a bundle', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  await screen.findByText('SRCV-005.mp4')
  fireEvent.dragStart(fileRow('SRCV-005.mp4'), { dataTransfer })
  const fileList = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  fireEvent.dragOver(fileList, { dataTransfer })
  fireEvent.drop(fileList, { dataTransfer })

  await waitFor(() =>
    expect(
      [...review.container.querySelectorAll('.grp-file__name')].map((node) => node.textContent),
    ).toEqual(['SRCV-005.mp3', 'cover.jpg', 'SRCV-005.mp4', 'second.mp4']),
  )
  const moveCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/files/file1/move') && init?.method === 'PUT',
  )
  expect(moveCall?.[1]).toMatchObject({
    body: JSON.stringify({ target_proposal_id: 'proposal1', target_index: 3 }),
  })
})

test('drags a file row onto another bundle suggestion heading', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  fireEvent.click(await screen.findByRole('button', { name: 'Show files' }))
  const source = screen.getByText('cover.jpg').closest('.grp-file')
  const target = screen
    .getByRole('button', { name: 'Rename bundle suggestion Second bundle' })
    .closest('.grp-row--bundle')
  if (!source || !target) throw new Error('missing file drag source or bundle drop target')

  fireEvent.dragStart(source, { dataTransfer })
  fireEvent.dragOver(target, { dataTransfer })
  expect(target).toHaveClass('grp-row--file-drop')
  fireEvent.drop(target, { dataTransfer })

  const targetFiles = screen.getByRole('list', { name: 'Files in Second bundle' })
  await waitFor(() =>
    expect(
      [...targetFiles.querySelectorAll('.grp-file__name')].map((node) => node.textContent),
    ).toEqual(['second.mp4', 'cover.jpg']),
  )
  const moveCall = fetchMock.mock.calls.find(([url]) => url.endsWith('/files/file3/move'))
  expect(moveCall?.[1]).toMatchObject({
    body: JSON.stringify({ target_proposal_id: 'proposal2', target_index: 1 }),
  })
})

test('auto-deselects a bundle after its last file is dragged away', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  const sourceCheckbox = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  expect(sourceCheckbox).toBeChecked()
  fireEvent.dragStart(fileRow('second.mp4'), { dataTransfer })
  const target = screen.getByRole('list', { name: 'Files in SRCV-005 - cut' })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })

  await waitFor(() => {
    expect(sourceCheckbox).not.toBeChecked()
    expect(sourceCheckbox).toBeDisabled()
  })
  expect([...target.querySelectorAll('.grp-file__name')].map((node) => node.textContent)).toEqual([
    'SRCV-005.mp4',
    'SRCV-005.mp3',
    'cover.jpg',
    'second.mp4',
  ])
})

test('drags a bundle suggestion into a collection suggestion', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  await screen.findByText('SRCV-005 - cut')
  fireEvent.dragStart(bundleRow('SRCV-005 - cut'), { dataTransfer })
  const title = screen.getByRole('button', { name: 'Rename collection suggestion Movies' })
  const collectionRow = title.closest('.grp-row')
  if (!collectionRow) throw new Error('missing collection row')
  fireEvent.dragOver(collectionRow, { dataTransfer })
  fireEvent.drop(collectionRow, { dataTransfer })

  await screen.findByText('Bundle moved into “Movies”.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: 'collection1', target_collection_id: null }),
  })
})

test('auto-deselects a collection after its last bundle is dragged out', async () => {
  const initial = PROPOSALS.map((proposal) =>
    proposal.id === 'proposal1' ? { ...proposal, parent_proposal_id: 'collection1' } : proposal,
  )
  const fetchMock = mockGroupingApi(initial)
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  const collectionCheckbox = await screen.findByRole('checkbox', {
    name: 'Select bundles in Movies',
  })
  expect(collectionCheckbox).toBeChecked()
  expect(review.container.querySelector('.grp-root-drop')).not.toBeInTheDocument()
  fireEvent.dragStart(bundleRow('SRCV-005 - cut'), { dataTransfer })
  const rootTarget = review.container.querySelector('.grp-root-drop')
  if (!rootTarget) throw new Error('missing root drop target')
  fireEvent.dragOver(rootTarget, { dataTransfer })
  fireEvent.drop(rootTarget, { dataTransfer })

  await waitFor(() => {
    expect(collectionCheckbox).not.toBeChecked()
    expect(collectionCheckbox).toBeDisabled()
  })
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: null }),
  })
})

test('selecting one nested bundle leaves its collection ancestors indeterminate', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const outer = await screen.findByRole('checkbox', { name: 'Select bundles in Library' })
  const inner = screen.getByRole('checkbox', { name: 'Select bundles in Series' })
  const first = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  const second = screen.getByRole('checkbox', { name: 'Accept Episode Two' })
  const sibling = screen.getByRole('checkbox', { name: 'Accept Feature' })
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(first).not.toBeChecked())

  fireEvent.click(first)

  await waitFor(() => {
    expect(first).toBeChecked()
    expect(second).not.toBeChecked()
    expect(sibling).not.toBeChecked()
    expect(inner).toBePartiallyChecked()
    expect(outer).toBePartiallyChecked()
  })
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Collapse collection suggestion Library' }))
  expect(first).not.toBeVisible()
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const applyCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
  )
  expect(JSON.parse(applyCall?.[1]?.body as string)).toEqual({ proposal_ids: ['nested-one'] })
})

test('a nested collection checkbox selects only its descendant bundles', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const inner = await screen.findByRole('checkbox', { name: 'Select bundles in Series' })
  const outer = screen.getByRole('checkbox', { name: 'Select bundles in Library' })
  const first = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  const second = screen.getByRole('checkbox', { name: 'Accept Episode Two' })
  const sibling = screen.getByRole('checkbox', { name: 'Accept Feature' })
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(inner).not.toBeChecked())

  fireEvent.click(inner)

  await waitFor(() => {
    expect(inner).toBeChecked()
    expect(first).toBeChecked()
    expect(second).toBeChecked()
    expect(sibling).not.toBeChecked()
    expect(outer).toBePartiallyChecked()
  })
  expect(screen.getByText('2 bundles selected')).toBeInTheDocument()
})

test('existing collection context is labeled and cannot be edited or moved', async () => {
  const proposals = NESTED_PROPOSALS.map((proposal) =>
    proposal.kind === 'container'
      ? {
          ...proposal,
          target_collection_id: `target-${proposal.id}`,
          is_collection_context: true,
        }
      : proposal,
  )
  vi.stubGlobal('fetch', mockGroupingApi(proposals))
  renderReview()

  const title = await screen.findByText('Series', { selector: '.grp-title' })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing existing collection row')
  expect(within(row as HTMLElement).getByText('Existing')).toBeInTheDocument()
  expect(row).toHaveAttribute('draggable', 'false')
  expect(
    within(row as HTMLElement).queryByRole('button', {
      name: 'Rename collection suggestion Series',
    }),
  ).toBeNull()
  expect(
    within(row as HTMLElement).queryByRole('button', {
      name: 'Placement for collection suggestion Series',
    }),
  ).toBeNull()
  await expectNoRowAction('Make this one bundle instead')
})

// A folder suggestion may resolve to a collection that already exists, so apply
// reuses it rather than creating a duplicate. That is a *destination*, not a
// claim of immutability — the row is still the owner's to rename, move, or
// reclassify. Gating read-only rendering on `target_collection_id` froze exactly
// these rows whenever a folder happened to share a collection's name.
test('a folder suggestion that reuses an existing collection stays editable', async () => {
  const proposals = NESTED_PROPOSALS.map((proposal) =>
    proposal.kind === 'container'
      ? {
          ...proposal,
          target_collection_id: `target-${proposal.id}`,
          is_collection_context: false,
        }
      : proposal,
  )
  vi.stubGlobal('fetch', mockGroupingApi(proposals))
  renderReview()

  const title = await screen.findByText('Series', { selector: '.grp-title' })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing collection row')
  expect(within(row as HTMLElement).queryByText('Existing')).toBeNull()
  expect(row).toHaveAttribute('draggable', 'true')
  expect(
    within(row as HTMLElement).getByRole('button', {
      name: 'Rename collection suggestion Series',
    }),
  ).toBeInTheDocument()
  expect(
    within(row as HTMLElement).getByRole('button', {
      name: 'Placement for collection suggestion Series',
    }),
  ).toBeInTheDocument()
})

test('a proposed collection placement control moves between parent and top level', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const label = 'Placement for collection suggestion Series'
  fireEvent.click(await screen.findByRole('button', { name: label }))
  fireEvent.click(
    within(screen.getByRole('listbox', { name: 'Collection destinations' })).getByRole('option', {
      name: 'Top level',
    }),
  )
  await screen.findByText('Collection moved to the top level.')

  fireEvent.click(screen.getByRole('button', { name: label }))
  fireEvent.click(
    within(screen.getByRole('listbox', { name: 'Collection destinations' })).getByRole('option', {
      name: 'Current Archive',
    }),
  )
  await screen.findByText('Collection moved into “Current Archive”.')

  const bodies = fetchMock.mock.calls
    .filter(
      ([url, init]) => url.endsWith('/proposals/inner-collection/parent') && init?.method === 'PUT',
    )
    .map(([, init]) => JSON.parse(init?.body as string))
  expect(bodies).toEqual([
    { parent_proposal_id: null, target_collection_id: null },
    { parent_proposal_id: null, target_collection_id: 'current-archive' },
  ])
})

/** Open row overflow menus until one offers `name`, and return that item.
 *
 * The destination, bundle/collection and stem actions moved out of loose icon
 * buttons into a named per-row menu, so a test asks for the action rather than
 * for the glyph that used to represent it.
 */
/** Open a row's overflow menu and return the named action inside it.
 *
 * The destination, bundle/collection and stem actions moved out of loose icon
 * buttons into a named per-row menu, so a test asks for the action rather than
 * for the glyph that used to represent it. Pass `subject` (for example
 * `bundle suggestion Two Subjects`) when it matters *which* row offers it;
 * without it, the first row whose menu carries the action wins.
 */
/** Assert an action is absent — only meaningful once rows exist.
 *
 * `queryRowAction` returns null both when no row offers the action and when no
 * row has rendered yet, so a bare negative assertion after `renderReview()`
 * passed against an empty DOM and would have passed if the action *were*
 * offered. This awaits the rows first.
 */
async function expectNoRowAction(name: string | RegExp, subject?: string): Promise<void> {
  await screen.findAllByRole('button', { name: /^Actions for / })
  expect(queryRowAction(name, subject)).toBeNull()
}

function queryRowAction(name: string | RegExp, subject?: string): HTMLElement | null {
  // A previous lookup may have left its menu open, in which case the first
  // click below would close it rather than open the one being looked for.
  for (const open of screen.queryAllByRole('button', { name: /^Actions for / })) {
    if (open.getAttribute('aria-expanded') === 'true') fireEvent.click(open)
  }
  const triggers = subject
    ? screen.queryAllByRole('button', { name: `Actions for ${subject}` })
    : screen.queryAllByRole('button', { name: /^Actions for / })
  for (const trigger of triggers) {
    fireEvent.click(trigger)
    // AllBy: a regex can match both endpoints of a pair, and queryBy throws.
    const item = screen.queryAllByRole('menuitem', { name })[0] ?? null
    if (item) return item
    fireEvent.click(trigger)
  }
  return null
}

/** Await the rows, then find the action — for the first lookup in a test. */
async function findRowActionAsync(name: string | RegExp, subject?: string): Promise<HTMLElement> {
  await screen.findAllByRole('button', { name: /^Actions for / })
  return findRowAction(name, subject)
}

function findRowAction(name: string | RegExp, subject?: string): HTMLElement {
  const item = queryRowAction(name, subject)
  if (!item) throw new Error(`no row menu offers ${String(name)}`)
  return item
}

test('a run of identical-shape suggestions folds into one row', async () => {
  // Four numbered clips the suggester treated identically: same file count,
  // same kinds, same reason. They are the rows an owner scrolls past.
  const clips = [1, 2, 3, 4].map((i) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `SET-025-0${i}`,
    reason: 'numbered sequence',
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/SET-025-0${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
      {
        asset_file_id: `c${i}`,
        relative_path: `d/SET-025-0${i}.webp`,
        proposed_role: 'cover' as const,
        sequence: 1,
      },
    ],
  }))
  vi.stubGlobal('fetch', mockGroupingApi(clips))
  renderReview()

  const rollup = await screen.findByText('SET-025-01 … SET-025-04')
  expect(screen.getByText('4 bundles, same shape · each 2 files · video, image')).toBeVisible()
  // The individual rows are not rendered until asked for.
  expect(screen.queryByRole('checkbox', { name: 'Accept SET-025-02' })).toBeNull()
  // ...but they are all still selected, and Accept still counts them.
  expect(screen.getByRole('button', { name: 'Accept 4 bundles' })).toBeEnabled()

  // One checkbox skips the whole run.
  const combined = screen.getByRole('checkbox', {
    name: 'Accept 4 suggestions from SET-025-01 … SET-025-04',
  })
  expect(combined).toBeChecked()
  fireEvent.click(combined)
  expect(screen.getByText('0 bundles selected')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Show all 4' }))

  expect(screen.getByRole('checkbox', { name: 'Accept SET-025-02' })).toBeInTheDocument()
  expect(rollup).not.toBeInTheDocument()
})

test('a run stops at a suggestion worth looking at', async () => {
  // The low-confidence row is never folded away, and it breaks the run.
  const shape = (i: number, confidence: number) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `Clip 0${i}`,
    reason: 'numbered sequence',
    confidence,
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/c${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
    ],
  })
  vi.stubGlobal(
    'fetch',
    mockGroupingApi([shape(1, 0.9), shape(2, 0.5), shape(3, 0.9), shape(4, 0.9), shape(5, 0.9)]),
  )
  renderReview()

  // The uncertain row keeps its own line…
  expect(await screen.findByRole('checkbox', { name: 'Accept Clip 02' })).toBeInTheDocument()
  // …the three after it are a run…
  expect(screen.getByText('Clip 03 … Clip 05')).toBeVisible()
  // …and the single row before it is too short to fold.
  expect(screen.getByRole('checkbox', { name: 'Accept Clip 01' })).toBeInTheDocument()
})

test('the review can be driven from the keyboard', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  await screen.findByRole('button', { name: 'Rename collection suggestion Library' })
  const tree = screen.getByRole('list', { name: /^Grouping suggestions/ })
  const rowOf = (name: string) =>
    screen.getByRole('button', { name }).closest('.grp-row') as HTMLElement

  // The tree is one tab stop; the first arrow lands on the first row.
  tree.focus()
  fireEvent.keyDown(tree, { key: 'ArrowDown' })
  const library = rowOf('Rename collection suggestion Library')
  expect(library).toHaveFocus()

  // Left folds, right unfolds — via the row's own disclosure.
  fireEvent.keyDown(library, { key: 'ArrowLeft' })
  expect(
    screen.getByRole('button', { name: 'Expand collection suggestion Library' }),
  ).toHaveAttribute('aria-expanded', 'false')
  fireEvent.keyDown(library, { key: 'ArrowRight' })
  expect(
    screen.getByRole('button', { name: 'Collapse collection suggestion Library' }),
  ).toHaveAttribute('aria-expanded', 'true')

  // Down reaches the nested rows, and space toggles the row's checkbox.
  fireEvent.keyDown(library, { key: 'ArrowDown' })
  const series = rowOf('Rename collection suggestion Series')
  expect(series).toHaveFocus()
  fireEvent.keyDown(series, { key: 'ArrowDown' })
  const episode = rowOf('Rename bundle suggestion Episode One')
  expect(episode).toHaveFocus()

  const accept = screen.getByRole('checkbox', { name: 'Accept Episode One' })
  expect(accept).toBeChecked()
  fireEvent.keyDown(episode, { key: ' ' })
  expect(accept).not.toBeChecked()

  // Cmd+Enter applies without reaching for the footer.
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/apply'))).toBe(true),
  )
})

test('a key press inside a row control is left to that control', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  const title = await screen.findByRole('button', {
    name: 'Rename bundle suggestion SRCV-005 - cut',
  })
  fireEvent.doubleClick(title)
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  const checkbox = screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  const checkedBefore = (checkbox as HTMLInputElement).checked

  // Space in the rename box is a space, not an accept toggle.
  fireEvent.keyDown(input, { key: ' ' })
  expect((checkbox as HTMLInputElement).checked).toBe(checkedBefore)
  expect(input).toBeInTheDocument()
})

// --- Review fixes (2026-08-10) -----------------------------------------------

test('Cmd+Enter obeys the same guards as the Accept button', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const tree = await screen.findByRole('list', { name: /^Grouping suggestions/ })
  const applied = () => fetchMock.mock.calls.some(([url]) => url.endsWith('/apply'))

  // Nothing selected: the button is disabled, so the shortcut must be too.
  fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept/ })).toBeDisabled())
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  expect(applied()).toBe(false)

  // Mid-rename: likewise blocked, and the keystroke belongs to the text box.
  fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
  fireEvent.doubleClick(
    screen.getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' }),
  )
  const input = screen.getByRole('textbox', { name: 'Bundle suggestion title' })
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  expect(applied()).toBe(false)

  // Escape out of the rename, and then it works.
  fireEvent.keyDown(input, { key: 'Escape' })
  await waitFor(() => expect(screen.getByRole('button', { name: /^Accept/ })).toBeEnabled())
  fireEvent.keyDown(tree, { key: 'Enter', metaKey: true })
  await waitFor(() => expect(applied()).toBe(true))
})

test('a read-only existing-collection row offers no folder actions', async () => {
  const context = {
    ...NESTED_PROPOSALS[0]!,
    target_collection_id: 'live',
    is_collection_context: true,
  }
  vi.stubGlobal('fetch', mockGroupingApi([context, ...NESTED_PROPOSALS.slice(1)]))
  renderReview()

  // Split/Merge regenerate plan rows for a directory this row does not name.
  await expectNoRowAction(/into (more|fewer) bundles/, 'collection suggestion Library')
})

test('an unrecognised stem mode offers no folder actions', async () => {
  vi.stubGlobal(
    'fetch',
    mockGroupingApi(undefined, undefined, { 'SRCV-005': 'exact', Second: 'exact' }),
  )
  renderReview()

  // index === -1 slipped past both endpoint guards: Merge resolved to `narrow`
  // and split the folder instead.
  await expectNoRowAction(/into (more|fewer) bundles/)
})

test('an expanded run can be folded back', async () => {
  const clips = [1, 2, 3].map((i) => ({
    ...PROPOSALS[1]!,
    id: `clip-${i}`,
    title: `Clip 0${i}`,
    reason: 'numbered sequence',
    files: [
      {
        asset_file_id: `v${i}`,
        relative_path: `d/c${i}.mp4`,
        proposed_role: 'primary_video' as const,
        sequence: 0,
      },
    ],
  }))
  vi.stubGlobal('fetch', mockGroupingApi(clips))
  renderReview()

  fireEvent.click(await screen.findByRole('button', { name: 'Show all 3' }))
  expect(screen.getByRole('checkbox', { name: 'Accept Clip 02' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Fold 3 back into one row' }))

  expect(screen.queryByRole('checkbox', { name: 'Accept Clip 02' })).toBeNull()
  expect(screen.getByText('Clip 01 … Clip 03')).toBeVisible()
})

test('Collapse all is disabled when there is nothing to collapse', async () => {
  vi.stubGlobal('fetch', mockGroupingApi([PROPOSALS[1]!]))
  renderReview()

  await screen.findByRole('checkbox', { name: 'Accept SRCV-005 - cut' })
  // A flat plan has no collections; the button used to be enabled and inert.
  expect(screen.getByRole('button', { name: 'Collapse all' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled()
})

test('arrow keys keep working after focus lands on a row control', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS))
  renderReview()

  const first = await screen.findByRole('checkbox', { name: 'Select bundles in Library' })
  first.focus()
  expect(first).toHaveFocus()

  // Navigation used to die here until the owner clicked bare row whitespace.
  fireEvent.keyDown(first, { key: 'ArrowDown' })
  expect(
    screen.getByRole('button', { name: 'Rename collection suggestion Series' }).closest('.grp-row'),
  ).toHaveFocus()
})

// --- Triage: confidence filter, contents summary, compact placement ----------

test('every row states its confidence, and the guessed ones are counted', async () => {
  // Replaced a two-tab filter: hiding the confident rows meant a *mis*-scored row
  // was filtered out of the view claiming to show what needed deciding.
  const unsure = { ...PROPOSALS[1]!, id: 'weak', title: 'Loose Clip', confidence: 0.5 }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, unsure]))
  renderReview()

  // Nothing is hidden: both rows are present, each carrying its own label.
  await screen.findByRole('checkbox', { name: 'Accept Loose Clip' })
  expect(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })).toBeInTheDocument()
  expect(screen.getByText('1 guessed from the folder')).toBeInTheDocument()

  const weakRow = screen
    .getByRole('button', { name: 'Rename bundle suggestion Loose Clip' })
    .closest('.grp-row') as HTMLElement
  expect(within(weakRow).getByText('guessed')).toBeInTheDocument()

  const strongRow = screen
    .getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' })
    .closest('.grp-row') as HTMLElement
  expect(within(strongRow).getByText('matched')).toBeInTheDocument()

  // No filter tabs to hide anything behind.
  expect(screen.queryByRole('button', { name: /Needs a look/ })).toBeNull()
})

test('a flagged row carries its reason; a confident one carries its contents', async () => {
  const unsure = {
    ...PROPOSALS[1]!,
    id: 'weak',
    title: 'Loose Clip',
    confidence: 0.5,
    reason: 'grouped by folder',
  }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, unsure]))
  const review = renderReview()

  await screen.findByRole('checkbox', { name: 'Accept Loose Clip' })
  const flagged = screen
    .getByRole('button', { name: 'Rename bundle suggestion Loose Clip' })
    .closest('.grp-row')
  expect(flagged).toHaveClass('grp-row--attention')
  expect(within(flagged as HTMLElement).getByText('grouped by folder')).toBeInTheDocument()

  const confident = screen
    .getByRole('button', { name: 'Rename bundle suggestion SRCV-005 - cut' })
    .closest('.grp-row')
  expect(confident).not.toHaveClass('grp-row--attention')
  expect(review.container.querySelectorAll('.grp-row--attention')).toHaveLength(1)
})

test('the footer names what Accept does and what it leaves behind', async () => {
  const addition = { ...ADDITION, id: 'add-1' }
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, addition]))
  renderReview()

  // Two new bundles plus one addition, all selected to begin with.
  expect(await screen.findByRole('button', { name: 'Accept 2 bundles + 1 addition' })).toBeEnabled()
  expect(screen.queryByText(/skipped/)).toBeNull()

  fireEvent.click(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' }))

  expect(screen.getByRole('button', { name: 'Accept 1 bundle + 1 addition' })).toBeEnabled()
  expect(
    screen.getByText('1 skipped stays unbundled and is suggested again next scan'),
  ).toBeInTheDocument()
})

test('a root row keeps its printed destination', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  const anchor = await screen.findByRole('button', {
    name: 'Placement for bundle suggestion SRCV-005 - cut',
  })
  expect(anchor.closest('.grp-placement-picker')).not.toHaveClass('grp-placement-picker--compact')
  expect(within(anchor).getByText('Top level')).toBeInTheDocument()
})

test('placement picker excludes draft collections when the library has none', async () => {
  vi.stubGlobal('fetch', mockGroupingApi(NESTED_PROPOSALS, []))
  renderReview()

  const anchor = await screen.findByRole('button', {
    name: 'Placement for bundle suggestion Episode One',
  })
  // Nested, so the destination is the row it is drawn inside: the affordance
  // stays (and keeps its accessible name) but stops reprinting the indentation.
  expect(anchor.closest('.grp-placement-picker')).toHaveClass('grp-placement-picker--compact')
  expect(within(anchor).queryByText('Suggested: Series')).toBeNull()
  expect(anchor).toHaveAttribute('title', 'Current placement: Suggested: Library / Series')
  fireEvent.click(anchor)

  const list = screen.getByRole('listbox', { name: 'Collection destinations' })
  expect(within(list).getByRole('option', { name: 'Top level' })).toBeVisible()
  expect(within(list).queryByRole('option', { name: 'Library / Series' })).toBeNull()
  expect(within(list).getByText('No collections yet')).toBeVisible()
})

test('placement picker presents a foldable searchable hierarchy without repeated prefixes', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Placement for bundle suggestion Episode One',
    }),
  )
  const panel = screen.getByRole('dialog', { name: 'Place bundle suggestion Episode One' })
  const list = within(panel).getByRole('listbox', { name: 'Collection destinations' })
  expect(within(list).queryByRole('option', { name: 'Library / Series' })).toBeNull()
  const nested = within(list).getByRole('option', {
    name: 'Current Archive / Current Series',
  })
  expect(nested).toHaveTextContent('Current Series')
  expect(nested).not.toHaveTextContent('Current Archive / Current Series')

  fireEvent.click(
    within(panel).getByRole('button', { name: 'Collapse destination Current Archive' }),
  )
  expect(nested).not.toBeInTheDocument()
  fireEvent.click(within(panel).getByRole('button', { name: 'Expand destination Current Archive' }))
  expect(
    within(list).getByRole('option', { name: 'Current Archive / Current Series' }),
  ).toBeVisible()

  const search = within(panel).getByRole('textbox', { name: 'Search collection destinations' })
  fireEvent.change(search, { target: { value: 'Current Series' } })
  const result = within(list).getByRole('option', {
    name: 'Current Archive / Current Series',
  })
  expect(result).toHaveTextContent('Current Series')
  expect(result).not.toHaveTextContent('Current Archive / Current Series')
  fireEvent.change(search, { target: { value: 'Current Archive' } })
  fireEvent.keyDown(search, { key: 'Enter' })

  await screen.findByText('Bundle moved into “Current Archive”.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/nested-one/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: 'current-archive' }),
  })
})

test('drags a proposed collection to the top level', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  const title = await screen.findByRole('button', {
    name: 'Rename collection suggestion Series',
  })
  const row = title.closest('.grp-row--collection')
  if (!row) throw new Error('missing proposed collection row')
  fireEvent.dragStart(row, { dataTransfer })
  const rootTarget = review.container.querySelector('.grp-root-drop')
  if (!rootTarget) throw new Error('missing root drop target')
  fireEvent.dragOver(rootTarget, { dataTransfer })
  fireEvent.drop(rootTarget, { dataTransfer })

  await screen.findByText('Collection moved to the top level.')
  const reparentCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/inner-collection/parent') && init?.method === 'PUT',
  )
  expect(reparentCall?.[1]).toMatchObject({
    body: JSON.stringify({ parent_proposal_id: null, target_collection_id: null }),
  })
})

// --- Selection survives a Narrow/Widen regeneration ---------------------------

/** A grouping API whose regeneration mints fresh proposal ids, as the server does.
 *
 * `mockGroupingApi` reuses one proposal array across regeneration, so selection
 * tracked by id happens to survive there — the opposite of production, where
 * generating supersedes every row and issues new ULIDs. This mock reproduces the
 * real behavior so the regression is actually reachable.
 */
function mockRegeneratingApi() {
  let generation = 0
  let stemModes: Record<string, 'narrow' | 'balanced' | 'wide'> = {}
  const proposalsFor = (gen: number): GroupingProposal[] =>
    structuredClone(PROPOSALS).map((p) => ({ ...p, id: `${p.id}-gen${gen}` }))

  return vi.fn((url: string, init?: RequestInit) => {
    const planId = `plan-gen${generation}`
    let body: unknown
    if (url.endsWith('/grouping/plans') && init?.method === 'POST') {
      generation += 1
      stemModes = (
        JSON.parse(init.body as string) as {
          stem_modes: Record<string, 'narrow' | 'balanced' | 'wide'>
        }
      ).stem_modes
      body = {
        id: `plan-gen${generation}`,
        status: 'open',
        rule_version: 5,
        scan_job_id: null,
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:01:00Z',
        applied_at: null,
        proposals: proposalsFor(generation),
      }
    } else if (url.endsWith('/grouping/plans')) {
      body = [
        {
          id: planId,
          status: 'open',
          rule_version: 5,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: PROPOSALS.length,
        },
      ]
    } else if (url.match(/\/grouping\/plans\/plan-gen\d+$/)) {
      const gen = Number(url.match(/plan-gen(\d+)$/)![1])
      body = {
        id: `plan-gen${gen}`,
        status: 'open',
        rule_version: 5,
        scan_job_id: 'job1',
        stem_modes: stemModes,
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals: proposalsFor(gen),
      }
    } else {
      body = {}
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
}

function renderReviewAt(planId: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <GroupingReview initialPlanId={planId} onClose={vi.fn()} />
    </QueryClientProvider>,
  )
}

test('Widen keeps the suggestions the owner had already unchecked', async () => {
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  // The "Movies" container has no children, so it is empty and never selectable:
  // two of the three fixture proposals count.
  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  await screen.findByText('2 bundles selected')
  fireEvent.click(second)
  expect(second).not.toBeChecked()
  await screen.findByText('1 bundle selected')

  fireEvent.click(await findRowActionAsync('Merge SRCV-005 into fewer bundles'))
  await screen.findByText('SRCV-005 now uses wide stem matching.')

  // The adjusted directory's row returns as a fresh (checked) suggestion; the
  // deselection elsewhere survives.
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Accept Second bundle' })).not.toBeChecked(),
  )
  expect(screen.getByRole('checkbox', { name: 'Accept SRCV-005 - cut' })).toBeChecked()
  expect(screen.getByText('1 bundle selected')).toBeInTheDocument()
})

test('a conversion elsewhere survives Widen', async () => {
  // The larger owner-reported problem: adjusting one folder must not undo the
  // bundle→collection override made on another.
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, DIVISIBLE]))
  renderReview()

  fireEvent.click(
    await findRowActionAsync(
      'Make this a collection of bundles instead',
      'bundle suggestion Two Subjects',
    ),
  )
  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()

  fireEvent.click(findRowAction('Merge SRCV-005 into fewer bundles'))
  await screen.findByText('SRCV-005 now uses wide stem matching.')

  // Still a collection, child row intact, and the way back still offered.
  expect(screen.getByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  expect(
    findRowAction('Make this one bundle instead', 'collection suggestion Two Subjects'),
  ).toBeInTheDocument()
})

test('an explicit Suggest grouping starts from a clean selection', async () => {
  vi.stubGlobal('fetch', mockRegeneratingApi())
  renderReviewAt('plan-gen0')

  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  fireEvent.click(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Second bundle' }),
  )
  const secondFiles = screen.getByRole('list', { name: 'Files in Second bundle' })
  expect(secondFiles).toBeVisible()
  fireEvent.click(
    screen.getByRole('button', { name: 'Collapse files in bundle suggestion Second bundle' }),
  )
  expect(secondFiles).not.toBeVisible()
  fireEvent.click(second)
  await screen.findByText('1 bundle selected')

  fireEvent.click(screen.getByRole('button', { name: 'Suggest grouping' }))
  await screen.findByText('Suggestions generated from the current library state.')

  // Unlike Narrow/Widen, this is an explicit fresh start rather than an
  // adjustment, so everything comes back checked.
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Accept Second bundle' })).toBeChecked(),
  )
  // A fresh start resets view state too: the file list the owner had opened is
  // closed again, like the checkboxes are re-checked.
  expect(
    screen.getByRole('button', { name: 'Expand files in bundle suggestion Second bundle' }),
  ).toHaveAttribute('aria-expanded', 'false')
  expect(screen.getByText('2 bundles selected')).toBeInTheDocument()
})

// --- Bundle <-> collection override ------------------------------------------
test('turns a bundle suggestion into a collection of bundles', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await findRowActionAsync('Make this a collection of bundles instead'))

  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/divisible1/kind') && init?.method === 'PUT',
  )
  expect(put?.[1]).toMatchObject({ body: JSON.stringify({ kind: 'container' }) })

  // Its subjects are now bundles of their own, nested under it.
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Accept beta.mp4' })).toBeInTheDocument()
  // And the row offers the way back, so the override is not a one-way door.
  expect(
    findRowAction('Make this one bundle instead', 'collection suggestion Two Subjects'),
  ).toBeInTheDocument()
})

test('accepts only file-backed child bundles returned by a conversion', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  fireEvent.click(await findRowActionAsync('Make this a collection of bundles instead'))
  await screen.findByText('“Two Subjects” is now a collection of bundles.')

  fireEvent.click(screen.getByRole('button', { name: /^Accept / }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const applyCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/grouping/plans/plan1/apply') && init?.method === 'POST',
  )
  const payload = JSON.parse(applyCall?.[1]?.body as string) as { proposal_ids: string[] }
  expect(new Set(payload.proposal_ids)).toEqual(new Set(['divisible1-child0', 'divisible1-child1']))
})

test('a single-subject bundle may still become a collection', async () => {
  // The owner may be making a home for siblings to drag in, so this is offered
  // even though nothing divides.
  vi.stubGlobal('fetch', mockGroupingApi())
  renderReview()

  expect(await findRowActionAsync('Make this a collection of bundles instead')).toBeInTheDocument()
})

test('a single-subject bundle inside its own folder collection can still convert', async () => {
  // The client used to withhold the conversion here, on the grounds that another
  // layer would repeat the name it is inside. That is exactly the row an owner
  // reaches for it on — a folder holding one release that should be a collection
  // (owner-reported, 2026-08-13). The server still refuses the one conversion
  // that would rename nothing, and says so.
  const collection: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'own-folder',
    title: 'Second',
    directory: 'Second',
  }
  const child: GroupingProposal = { ...PROPOSALS[2]!, parent_proposal_id: collection.id }
  vi.stubGlobal('fetch', mockGroupingApi([collection, child]))
  renderReview()

  expect(
    await findRowActionAsync(
      'Make this a collection of bundles instead',
      `bundle suggestion ${child.title}`,
    ),
  ).toBeInTheDocument()
})

test('an addition suggestion offers no collection override', async () => {
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, ADDITION]))
  renderReview()

  // An addition puts its files into a bundle that already exists, which is not
  // going to become a collection.
  await screen.findByText(/Add to/)
  await expectNoRowAction(
    'Make this a collection of bundles instead',
    'bundle suggestion Add to Sky, Sand, Sea & Salt - 4K',
  )
})

// --- Tooltips do not outlive the control they belong to ----------------------
