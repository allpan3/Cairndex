import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { type GroupingProposal, setActiveLibraryId } from '../api/client'
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

/** Install a mutable grouping-plan API mock and return its fetch spy. */
function mockGroupingApi(initialProposals: GroupingProposal[] = PROPOSALS) {
  let proposals = structuredClone(initialProposals)
  let planId = 'plan1'
  let stemModes: Record<string, 'narrow' | 'balanced' | 'wide'> = {}
  return vi.fn((url: string, init?: RequestInit) => {
    let body: unknown
    if (url.endsWith('/grouping/plans') && init?.method === 'POST') {
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
      const parentProposalId = (
        JSON.parse(init.body as string) as {
          parent_proposal_id: string | null
        }
      ).parent_proposal_id
      proposals = proposals.map((proposal) =>
        proposal.id === proposalId
          ? { ...proposal, parent_proposal_id: parentProposalId }
          : proposal,
      )
      body = proposals.find((proposal) => proposal.id === proposalId)
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
  expect(screen.getByText('same filename stem')).toBeInTheDocument()
  expect(screen.getByText('same folder')).toBeInTheDocument()
  expect(review.container.querySelectorAll('.grp-conf')).toHaveLength(0)
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
  const createNew = screen.getByRole('button', {
    name: 'Create a new bundle from these files',
  })
  expect(createNew).toHaveAttribute('aria-pressed', 'false')
  expect(createNew).not.toHaveClass('is-active')
  expect(createNew).toHaveAttribute('data-tip', 'Create a new bundle from these files')
  fireEvent.click(createNew)

  const addToExisting = await screen.findByRole('button', {
    name: 'Add these files to “Sky, Sand, Sea & Salt - 4K” instead',
  })
  expect(addToExisting).toHaveAttribute('aria-pressed', 'true')
  expect(addToExisting).not.toHaveClass('is-active')
  expect(addToExisting).toHaveAttribute(
    'data-tip',
    'Add these files to “Sky, Sand, Sea & Salt - 4K” instead',
  )
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

  fireEvent.click(
    screen.getByRole('button', {
      name: 'Add these files to “Sky, Sand, Sea & Salt - 4K” instead',
    }),
  )
  await screen.findByText('Add to Sky, Sand, Sea & Salt - 4K')
  fireEvent.click(screen.getByRole('button', { name: 'Create a new bundle from these files' }))
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
  fireEvent.click(screen.getByRole('button', { name: 'Create a new bundle from these files' }))
  expect(
    await screen.findByRole('button', {
      name: 'Add these files to “Legacy Target” instead',
    }),
  ).toBeInTheDocument()
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

  const switchButton = await screen.findByRole('button', {
    name: 'Create a new bundle from these files',
  })
  fireEvent.click(switchButton)
  await waitFor(() => expect(switchButton).toBeDisabled())
  finishDestination?.()

  await screen.findByText('Existing bundle disappeared')
  expect(switchButton).toBeEnabled()
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

  const widen = await screen.findByRole('button', {
    name: 'Widen stem matching in SRCV-005',
  })
  fireEvent.click(widen)

  await screen.findByText('SRCV-005 now uses wide stem matching.')
  expect(screen.getByText('SRCV-005 - cut')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Widen stem matching in SRCV-005' })).toBeDisabled()
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

  const outerRow = (
    await screen.findByRole('button', { name: 'Rename collection suggestion Western' })
  ).closest('.grp-row') as HTMLElement
  const innerRow = screen
    .getByRole('button', { name: 'Rename collection suggestion Nora Vance' })
    .closest('.grp-row') as HTMLElement

  expect(
    within(outerRow).queryByLabelText('Stem matching for Western/Nora Vance'),
  ).not.toBeInTheDocument()
  expect(within(innerRow).getByLabelText('Stem matching for Western/Nora Vance')).toBeVisible()
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

  const source = (await screen.findByText('cover.jpg')).closest('.grp-file')
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
    body: JSON.stringify({ parent_proposal_id: 'collection1' }),
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
    body: JSON.stringify({ parent_proposal_id: null }),
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

  fireEvent.click(screen.getByRole('button', { name: 'Accept selected' }))
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
      ? { ...proposal, target_collection_id: `target-${proposal.id}` }
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
  expect(within(row as HTMLElement).queryByRole('combobox')).toBeNull()
  expect(
    within(row as HTMLElement).queryByRole('button', { name: 'Make this one bundle instead' }),
  ).toBeNull()
})

test('a proposed collection placement control moves between parent and top level', async () => {
  const fetchMock = mockGroupingApi(NESTED_PROPOSALS)
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const label = 'Placement for collection suggestion Series'
  fireEvent.change(await screen.findByRole('combobox', { name: label }), {
    target: { value: '' },
  })
  await screen.findByText('Collection moved to the top level.')

  fireEvent.change(screen.getByRole('combobox', { name: label }), {
    target: { value: 'outer-collection' },
  })
  await screen.findByText('Collection moved into “Library”.')

  const bodies = fetchMock.mock.calls
    .filter(
      ([url, init]) => url.endsWith('/proposals/inner-collection/parent') && init?.method === 'PUT',
    )
    .map(([, init]) => JSON.parse(init?.body as string))
  expect(bodies).toEqual([{ parent_proposal_id: null }, { parent_proposal_id: 'outer-collection' }])
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
    body: JSON.stringify({ parent_proposal_id: null }),
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

  fireEvent.click(await screen.findByRole('button', { name: 'Widen stem matching in SRCV-005' }))
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

  const secondRow = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  fireEvent.click(
    within(secondRow as HTMLElement).getByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  )
  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()

  fireEvent.click(await screen.findByRole('button', { name: 'Widen stem matching in SRCV-005' }))
  await screen.findByText('SRCV-005 now uses wide stem matching.')

  // Still a collection, child row intact, and the way back still offered.
  expect(screen.getByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  const converted = screen.getByText('Two Subjects').closest('.grp-row')!
  expect(
    within(converted as HTMLElement).getByRole('button', { name: 'Make this one bundle instead' }),
  ).toBeInTheDocument()
})

test('an explicit Suggest grouping starts from a clean selection', async () => {
  vi.stubGlobal('fetch', mockRegeneratingApi())
  renderReviewAt('plan-gen0')

  const second = await screen.findByRole('checkbox', { name: 'Accept Second bundle' })
  fireEvent.click(second)
  await screen.findByText('1 bundle selected')

  fireEvent.click(screen.getByRole('button', { name: 'Suggest grouping' }))
  await screen.findByText('Suggestions generated from the current library state.')

  // Unlike Narrow/Widen, this is an explicit fresh start rather than an
  // adjustment, so everything comes back checked.
  await waitFor(() =>
    expect(screen.getByRole('checkbox', { name: 'Accept Second bundle' })).toBeChecked(),
  )
  expect(screen.getByText('2 bundles selected')).toBeInTheDocument()
})

// --- Bundle <-> collection override ------------------------------------------
test('turns a bundle suggestion into a collection of bundles', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const bundleRow = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  fireEvent.click(
    within(bundleRow as HTMLElement).getByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  )

  await screen.findByText('“Two Subjects” is now a collection of bundles.')
  const put = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/divisible1/kind') && init?.method === 'PUT',
  )
  expect(put?.[1]).toMatchObject({ body: JSON.stringify({ kind: 'container' }) })

  // Its subjects are now bundles of their own, nested under it.
  expect(await screen.findByRole('checkbox', { name: 'Accept alpha.mp4' })).toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'Accept beta.mp4' })).toBeInTheDocument()
  // And the row offers the way back, so the override is not a one-way door.
  const converted = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  expect(
    within(converted as HTMLElement).getByRole('button', {
      name: 'Make this one bundle instead',
    }),
  ).toBeInTheDocument()
})

test('accepts only file-backed child bundles returned by a conversion', async () => {
  const fetchMock = mockGroupingApi([DIVISIBLE])
  vi.stubGlobal('fetch', fetchMock)
  renderReview()

  const bundleRow = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  fireEvent.click(
    within(bundleRow as HTMLElement).getByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  )
  await screen.findByText('“Two Subjects” is now a collection of bundles.')

  fireEvent.click(screen.getByRole('button', { name: 'Accept selected' }))
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

  const soloRow = (await screen.findByText('Second bundle')).closest('.grp-row')!
  expect(
    within(soloRow as HTMLElement).getByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  ).toBeInTheDocument()
})

test('a single-subject bundle already inside its own folder collection is not', async () => {
  // Another layer would just repeat the name it is already inside — and since the
  // child of a conversion always lands here, this is what bounds the nesting.
  const collection: GroupingProposal = {
    ...PROPOSALS[0]!,
    id: 'own-folder',
    title: 'Second',
    directory: 'Second',
  }
  const child: GroupingProposal = { ...PROPOSALS[2]!, parent_proposal_id: collection.id }
  vi.stubGlobal('fetch', mockGroupingApi([collection, child]))
  renderReview()

  const childRow = (await screen.findByText('Second bundle')).closest('.grp-row')!
  expect(
    within(childRow as HTMLElement).queryByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  ).toBeNull()
})

test('an addition suggestion offers no collection override', async () => {
  vi.stubGlobal('fetch', mockGroupingApi([...PROPOSALS, ADDITION]))
  renderReview()

  // An addition puts its files into a bundle that already exists, which is not
  // going to become a collection.
  const additionRow = (await screen.findByText(/Add to/)).closest('.grp-row')!
  expect(
    within(additionRow as HTMLElement).queryByRole('button', {
      name: 'Make this a collection of bundles instead',
    }),
  ).toBeNull()
})

// --- Tooltips do not outlive the control they belong to ----------------------

/** Hover a control the way React sees it: `onMouseEnter` is synthesised from
 * `mouseover`, so a native `mouseenter` never reaches the handler. */
function hover(element: HTMLElement) {
  fireEvent.mouseOver(element, { relatedTarget: document.body })
}

test('a tooltip is dismissed when its control is clicked', async () => {
  // Clicking is what moves the row out from under the pointer, and nothing makes
  // the pointer *leave* the button — so without an explicit dismiss the tooltip
  // hung around at its old coordinates, showing the new label.
  vi.stubGlobal('fetch', mockGroupingApi([DIVISIBLE]))
  renderReview()

  const row = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  const convert = within(row as HTMLElement).getByRole('button', {
    name: 'Make this a collection of bundles instead',
  })
  hover(convert.closest('.grp-tip-anchor') as HTMLElement)
  expect(
    screen.getByText('Make this a collection of bundles instead', { selector: '.grp-tip' }),
  ).toBeInTheDocument()

  fireEvent.click(convert)
  await waitFor(() => expect(document.querySelector('.grp-tip')).toBeNull())

  // And the conversion still went through.
  await screen.findByText('“Two Subjects” is now a collection of bundles.')
})

test('a tooltip is dismissed when its label changes underneath it', async () => {
  // Belt and braces for the same shape: a control whose action is applied
  // elsewhere still flips its own label, and a stale tooltip would contradict it.
  vi.stubGlobal('fetch', mockGroupingApi([DIVISIBLE]))
  renderReview()

  const row = (await screen.findByText('Two Subjects')).closest('.grp-row')!
  const convert = within(row as HTMLElement).getByRole('button', {
    name: 'Make this a collection of bundles instead',
  })
  fireEvent.click(convert)
  await screen.findByText('“Two Subjects” is now a collection of bundles.')

  // Re-hover the same control, now labelled the other way, and confirm the
  // tooltip that appears is the current one rather than a leftover.
  const flipped = within(
    screen.getByText('Two Subjects').closest('.grp-row') as HTMLElement,
  ).getByRole('button', { name: 'Make this one bundle instead' })
  hover(flipped.closest('.grp-tip-anchor') as HTMLElement)
  const tips = document.querySelectorAll('.grp-tip')
  expect(tips).toHaveLength(1)
  expect(tips[0]!.textContent).toBe('Make this one bundle instead')
})
