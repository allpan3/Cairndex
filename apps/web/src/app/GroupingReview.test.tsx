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
  confidence: 0.8,
  reason: 'add 2 new file(s) to existing bundle',
  files: [
    {
      asset_file_id: 'new-video',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.mp4',
      proposed_role: 'video_part',
      sequence: 0,
    },
    {
      asset_file_id: 'new-cover',
      relative_path: 'Western/Nora Vance/Surf On The Ridge - 4K.jpg',
      proposed_role: 'image',
      sequence: 1,
    },
  ],
}

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
  expect(screen.getByText('Add to 🎬 Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
  expect(screen.queryByText('➕')).not.toBeInTheDocument()
  expect(screen.getByText('2 new files')).toBeInTheDocument()
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
  expect(screen.getByText('2 files')).toBeInTheDocument()
  expect(screen.queryByText('manual')).not.toBeInTheDocument()
  expect(screen.queryByText('create 2 files as a new bundle')).not.toBeInTheDocument()
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
  await screen.findByText('Add to 🎬 Sky, Sand, Sea & Salt - 4K')
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

  expect(await screen.findByText('Add to 🎬 Legacy Target')).toBeInTheDocument()
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
  expect(screen.getByText('Add to 🎬 Sky, Sand, Sea & Salt - 4K')).toBeInTheDocument()
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

test('widens one folder and preserves that mode in the regenerated plan', async () => {
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
  const post = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/grouping/plans') && init?.method === 'POST',
  )
  expect(post?.[1]).toMatchObject({
    body: JSON.stringify({ stem_modes: { 'SRCV-005': 'wide' } }),
  })
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
  const bundle: GroupingProposal = {
    ...PROPOSALS[1]!,
    directory: 'Western/Nora Vance',
    parent_proposal_id: inner.id,
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

test('drags proposal files to reorder within a bundle', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()
  const dataTransfer = dragData()

  fireEvent.dragStart(await screen.findByRole('button', { name: 'Drag file SRCV-005.mp4' }), {
    dataTransfer,
  })
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

test('drags a file into another bundle suggestion', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  renderReview()
  const dataTransfer = dragData()

  fireEvent.dragStart(await screen.findByRole('button', { name: 'Drag file cover.jpg' }), {
    dataTransfer,
  })
  const target = screen.getByRole('list', { name: 'Files in Second bundle' })
  fireEvent.dragOver(target, { dataTransfer })
  fireEvent.drop(target, { dataTransfer })

  await waitFor(() =>
    expect([...target.querySelectorAll('.grp-file__name')].map((node) => node.textContent)).toEqual(
      ['second.mp4', 'cover.jpg'],
    ),
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
  fireEvent.dragStart(screen.getByRole('button', { name: 'Drag file second.mp4' }), {
    dataTransfer,
  })
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

  fireEvent.dragStart(await screen.findByRole('button', { name: 'Drag bundle SRCV-005 - cut' }), {
    dataTransfer,
  })
  const title = screen.getByRole('button', { name: 'Rename collection suggestion Movies' })
  const collectionRow = title.closest('.grp-row')
  if (!collectionRow) throw new Error('missing collection row')
  fireEvent.dragOver(collectionRow, { dataTransfer })
  fireEvent.drop(collectionRow, { dataTransfer })

  await screen.findByText('Bundle moved into the collection suggestion.')
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

  const collectionCheckbox = await screen.findByRole('checkbox', { name: 'Accept Movies' })
  expect(collectionCheckbox).toBeChecked()
  expect(review.container.querySelector('.grp-root-drop')).not.toBeInTheDocument()
  fireEvent.dragStart(screen.getByRole('button', { name: 'Drag bundle SRCV-005 - cut' }), {
    dataTransfer,
  })
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
