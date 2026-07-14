import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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

/** Install a mutable grouping-plan API mock and return its fetch spy. */
function mockGroupingApi() {
  let proposals = structuredClone(PROPOSALS)
  return vi.fn((url: string, init?: RequestInit) => {
    let body: unknown
    if (url.endsWith('/grouping/plans')) {
      body = [
        {
          id: 'plan1',
          status: 'open',
          rule_version: 2,
          generated_at: '2026-07-13T00:00:00Z',
          applied_at: null,
          proposal_count: proposals.length,
        },
      ]
    } else if (url.endsWith('/grouping/plans/plan1')) {
      body = {
        id: 'plan1',
        status: 'open',
        rule_version: 2,
        scan_job_id: 'job1',
        generated_at: '2026-07-13T00:00:00Z',
        applied_at: null,
        proposals,
      }
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
