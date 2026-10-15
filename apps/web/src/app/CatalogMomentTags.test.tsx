import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { runJob, type Job } from '../api/catalog'
import type { Moment } from '../api/client'
import { replicaRequest } from '../api/replicas'
import { CatalogMomentTags } from './CatalogMomentTags'

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
  vi.mocked(runJob).mockReset()
  vi.mocked(replicaRequest).mockImplementation(async (_library, path) => {
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
