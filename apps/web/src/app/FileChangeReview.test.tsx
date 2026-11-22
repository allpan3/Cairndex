import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, expect, test, vi } from 'vitest'
import { catalog } from '../api/catalog'
import { discovery, type DiscoveryCandidate } from '../api/discovery'
import { settleFileChangeCandidate } from './fileChange'
import { FileChangeReview } from './FileChangeReview'

vi.mock('../api/catalog', async (original) => ({
  ...(await original<typeof import('../api/catalog')>()),
  catalog: vi.fn(),
}))
vi.mock('../api/discovery', async (original) => ({
  ...(await original<typeof import('../api/discovery')>()),
  discovery: vi.fn(),
}))

const candidate: DiscoveryCandidate = {
  id: 'synthetic-change',
  path: 'Field/clip.mp4',
  body: {
    kind: 'verification',
    title: 'clip.mp4',
    target: null,
    reason: 'Complete content verification is needed for this local copy',
    files: [
      {
        id: 'file-1',
        path: 'Field/clip.mp4',
        generation: 'synthetic',
        evidence: { algorithm: 'sample-sha256-v1', size: 4096, digest: 'synthetic' },
      },
    ],
    unverified_count: 1,
  },
}

let accepted = false
beforeEach(() => {
  localStorage.clear()
  accepted = false
  vi.mocked(catalog).mockReset().mockResolvedValue({ items: [] })
  vi.mocked(discovery)
    .mockReset()
    .mockImplementation(async (_library, path, method) => {
      if (method === 'POST' && path.endsWith('/accept')) {
        accepted = true
        return {}
      }
      if (method === 'POST') return {}
      if (path.startsWith('/verifications/'))
        return {
          id: path.split('/')[2],
          candidate: candidate.id,
          state: 'succeeded',
          error: null,
          files: 1,
          verified: 1,
          bytes_read: 4096,
          total_bytes: 4096,
        }
      if (path.startsWith('/reviews/'))
        return {
          id: path.split('/')[2],
          state: accepted ? 'applied' : 'ready',
          intent: { candidate: candidate.id },
          prepared: null,
          error: null,
          receipt: 'synthetic-receipt',
          event: null,
        }
      return { items: [], next_cursor: null }
    })
})

// One click reads the file, prepares the review with that verification, and accepts it
test('Check and Restore verifies, prepares and accepts in order', async () => {
  const settled = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileChangeReview
        library="synthetic-library"
        editor="synthetic-editor"
        candidate={candidate}
        onSettled={settled}
      />
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Check and Restore' }))
  await waitFor(() => expect(settled).toHaveBeenCalledWith('clip.mp4 restored.'), {
    timeout: 5000,
  })
  expect(settled).toHaveBeenCalledTimes(1)
  const posts = vi
    .mocked(discovery)
    .mock.calls.filter(([, , method]) => method === 'POST')
    .map(([, path, , body]) => ({ path, body: body as Record<string, unknown> }))
  expect(posts.map((post) => post.path)).toEqual([
    '/verifications',
    '/reviews',
    expect.stringMatching(/^\/reviews\/.+\/accept$/),
  ])
  expect(posts[1]!.body.verification).toBe(posts[0]!.body.operation)
  expect(posts[1]!.body.candidate).toBe(candidate.id)
  expect(posts[2]!.body).toEqual({ receipt: 'synthetic-receipt' })
})

test('a single-choice repair pre-selects the missing file and describes the rename', async () => {
  const repairCandidate: DiscoveryCandidate = {
    id: 'synthetic-rename',
    path: 'Field/renamed_clip.mp4',
    body: {
      kind: 'repair',
      title: 'renamed_clip.mp4',
      target: null,
      reason: 'The missing identity requires your confirmation',
      choices: [{ file_id: 'file-missing', path: 'Field/original_clip.mp4' }],
      files: [
        {
          id: 'file-1',
          path: 'Field/renamed_clip.mp4',
          generation: 'synthetic',
          evidence: { algorithm: 'sha256', size: 1024, digest: 'synthetic' },
        },
      ],
      unverified_count: 0,
    },
  }
  vi.mocked(discovery).mockImplementation(async (_library, path, method) => {
    if (method === 'POST' && path.endsWith('/accept')) {
      accepted = true
      return {}
    }
    if (method === 'POST') return {}
    if (path.startsWith('/candidates/'))
      return {
        items: [{ file_id: 'file-missing', path: 'Field/original_clip.mp4' }],
        next_cursor: null,
      }
    if (path.startsWith('/reviews/'))
      return {
        id: path.split('/')[2],
        state: accepted ? 'applied' : 'ready',
        intent: { candidate: repairCandidate.id, repair_file: 'file-missing' },
        prepared: null,
        error: null,
        receipt: 'synthetic-receipt',
        event: null,
      }
    return { items: [], next_cursor: null }
  })
  const settled = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FileChangeReview
        library="synthetic-library"
        editor="synthetic-editor"
        candidate={repairCandidate}
        onSettled={settled}
      />
    </QueryClientProvider>,
  )
  expect(await screen.findByText('This file was renamed on disk.')).toBeInTheDocument()
  expect(screen.getByText(/original_clip\.mp4 → renamed_clip\.mp4/)).toBeInTheDocument()
  expect(screen.queryByText('Which missing file is this?')).not.toBeInTheDocument()
  const linkBtn = screen.getByRole('button', { name: 'Link' })
  expect(linkBtn).toBeEnabled()
  fireEvent.click(linkBtn)
  await waitFor(() =>
    expect(settled).toHaveBeenCalledWith('renamed_clip.mp4 linked to the missing file.'),
  )
  const reviewPost = vi
    .mocked(discovery)
    .mock.calls.find(([, path, method]) => method === 'POST' && path === '/reviews')
  expect((reviewPost?.[3] as Record<string, unknown>)?.repair_file).toBe('file-missing')
})

test('settleFileChangeCandidate settles unambiguous candidates and skips multi-choice repairs', async () => {
  const singleRepair: DiscoveryCandidate = {
    id: 'synthetic-single-repair',
    path: 'Field/renamed.mp4',
    body: {
      kind: 'repair',
      title: 'renamed.mp4',
      target: null,
      reason: 'The missing identity requires your confirmation',
      choices: [{ file_id: 'file-missing', path: 'Field/original.mp4' }],
      files: [
        {
          id: 'file-1',
          path: 'Field/renamed.mp4',
          generation: 'synthetic',
          evidence: { algorithm: 'sha256', size: 1024, digest: 'synthetic' },
        },
      ],
      unverified_count: 0,
    },
  }
  const multiRepair: DiscoveryCandidate = {
    ...singleRepair,
    id: 'synthetic-multi-repair',
    body: {
      ...singleRepair.body,
      choices: [
        { file_id: 'file-a', path: 'Field/a.mp4' },
        { file_id: 'file-b', path: 'Field/b.mp4' },
      ],
    },
  }
  const appliedReviews = new Set<string>()
  vi.mocked(discovery).mockImplementation(async (_library, path, method, body) => {
    if (method === 'POST' && path.endsWith('/accept')) {
      const reviewId = path.split('/')[2]!
      appliedReviews.add(reviewId)
      return {}
    }
    if (method === 'POST') return {}
    if (path.startsWith('/verifications/'))
      return {
        id: path.split('/')[2],
        candidate: candidate.id,
        state: 'succeeded',
        error: null,
        files: 1,
        verified: 1,
        bytes_read: 4096,
        total_bytes: 4096,
      }
    if (path.startsWith('/reviews/')) {
      const reviewId = path.split('/')[2]!
      return {
        id: reviewId,
        state: appliedReviews.has(reviewId) ? 'applied' : 'ready',
        intent: (body as Record<string, unknown>) ?? {},
        prepared: null,
        error: null,
        receipt: 'synthetic-receipt',
        event: null,
      }
    }
    return { items: [], next_cursor: null }
  })

  expect(await settleFileChangeCandidate('synthetic-library', candidate)).toBe(true)
  expect(await settleFileChangeCandidate('synthetic-library', singleRepair)).toBe(true)
  expect(await settleFileChangeCandidate('synthetic-library', multiRepair)).toBe(false)
})
