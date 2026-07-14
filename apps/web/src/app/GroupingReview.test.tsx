import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { setActiveLibraryId } from '../api/client'
import { GroupingReview } from './GroupingReview'

const PROPOSAL = {
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
}

/** Install a mutable grouping-plan API mock and return its fetch spy. */
function mockGroupingApi() {
  let title = PROPOSAL.title
  let files = PROPOSAL.files
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
          proposal_count: 1,
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
        proposals: [{ ...PROPOSAL, title, files }],
      }
    } else if (
      url.endsWith('/grouping/plans/plan1/proposals/proposal1') &&
      init?.method === 'PATCH'
    ) {
      title = (JSON.parse(init.body as string) as { title: string }).title
      body = { ...PROPOSAL, title, files }
    } else if (url.endsWith('/proposals/proposal1/files/order') && init?.method === 'PUT') {
      const orderedIds = (JSON.parse(init.body as string) as { ordered_ids: string[] }).ordered_ids
      const byId = new Map(files.map((file) => [file.asset_file_id, file]))
      files = orderedIds.map((id, sequence) => ({ ...byId.get(id)!, sequence }))
      body = files
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

test('moves proposal files and persists the reviewed order', async () => {
  const fetchMock = mockGroupingApi()
  vi.stubGlobal('fetch', fetchMock)
  const review = renderReview()

  fireEvent.click(await screen.findByRole('button', { name: 'Move SRCV-005.mp4 down' }))

  await waitFor(() =>
    expect(
      [...review.container.querySelectorAll('.grp-file__name')].map((node) => node.textContent),
    ).toEqual(['SRCV-005.mp3', 'SRCV-005.mp4', 'cover.jpg']),
  )
  const reorderCall = fetchMock.mock.calls.find(
    ([url, init]) => url.endsWith('/proposals/proposal1/files/order') && init?.method === 'PUT',
  )
  expect(reorderCall?.[1]).toMatchObject({
    body: JSON.stringify({ ordered_ids: ['file2', 'file1', 'file3'] }),
  })
})
