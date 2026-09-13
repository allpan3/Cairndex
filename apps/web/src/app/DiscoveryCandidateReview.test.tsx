import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { discovery, type DiscoveryCandidate } from '../api/discovery'
import { CandidateReview } from './DiscoveryCandidateReview'
import { validSelection } from './discoverySelection'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/discovery', async (original) => ({
  ...(await original<typeof import('../api/discovery')>()),
  discovery: vi.fn(),
}))

const files = Array.from({ length: 201 }, (_, index) => ({
  id: `file-${index}`,
  path: `Album/frame${index}.png`,
  generation: 'synthetic',
  evidence: { algorithm: 'sha256', size: 10, digest: 'synthetic' },
  group: 'album',
}))
const candidate: DiscoveryCandidate = {
  id: 'synthetic-candidate',
  path: files[0]!.path,
  body: {
    version: 2,
    kind: 'new',
    title: 'Album',
    target: null,
    reason: 'Complete album',
    files: files.slice(0, 50),
    file_count: 201,
    files_next: 49,
    unverified_count: 0,
  },
}

// The real draft and paging controls use isolated transport responses and no owner metadata
beforeEach(() => {
  localStorage.clear()
  vi.mocked(catalog).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(discovery)
    .mockReset()
    .mockImplementation(async (_library, path, method) => {
      if (method === 'POST') return { id: 'prepared-operation' }
      if (path.includes('/groups')) return { items: [], next_cursor: null, total: 1 }
      const after = Number(path.split('after=')[1] ?? -1)
      const items = files.slice(after + 1, after + 51)
      return {
        items,
        next_cursor: after + 51 < files.length ? after + 50 : null,
        total: files.length,
      }
    })
})

// Selecting a later-page exception never turns the visible window into the complete selection
test('prepares all 201 files with a later-page exclusion', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const prepared = vi.fn()
  render(
    <QueryClientProvider client={client}>
      <CandidateReview
        library="synthetic"
        editor="synthetic-editor"
        candidate={candidate}
        onPrepared={prepared}
      />
    </QueryClientProvider>,
  )
  await screen.findByRole('checkbox', { name: 'Album/frame0.png' })
  fireEvent.click(screen.getByRole('button', { name: 'Next files' }))
  const later = await screen.findByRole('checkbox', { name: 'Album/frame50.png' })
  expect(later).toBeChecked()
  fireEvent.click(later)
  fireEvent.click(screen.getByRole('button', { name: 'Prepare grouping review' }))
  await waitFor(() => expect(prepared).toHaveBeenCalledWith('prepared-operation'))
  const request = vi.mocked(discovery).mock.calls.find((call) => call[2] === 'POST')![3]
  expect(request).toMatchObject({ candidate: 'synthetic-candidate', exclude_files: ['file-50'] })
  expect(request).not.toHaveProperty('files')
  expect(request).not.toHaveProperty('target')
})

// Older saved explicit selections retain all IDs instead of becoming malformed at an arbitrary count
test('retains explicit saved selections larger than 128 files', () => {
  expect(validSelection({ files: JSON.stringify(files.map((file) => file.id)) })).toBe(true)
  expect(validSelection({ files: '{invalid' })).toBe(false)
})
