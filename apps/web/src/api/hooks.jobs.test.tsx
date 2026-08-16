import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { JobRead } from './client'
import { useIndexNewLibrary, useScan, useUpdateLibrary } from './hooks'

const api = vi.hoisted(() => ({
  enqueueScan: vi.fn(),
  enqueueProbe: vi.fn(),
  enqueueStoryboards: vi.fn(),
}))

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  enqueueScan: api.enqueueScan,
  enqueueProbe: api.enqueueProbe,
  enqueueStoryboards: api.enqueueStoryboards,
}))

function job(over: Partial<JobRead> = {}): JobRead {
  return {
    id: 'j1',
    library_id: 'lib1',
    job_type: 'storyboard',
    status: 'succeeded',
    phase: null,
    message: null,
    payload: {},
    processed: 0,
    total: 50,
    result: null,
    error: null,
    cancel_requested: false,
    created_at: '2026-07-30T00:00:00Z',
    started_at: '2026-07-30T00:00:00Z',
    finished_at: '2026-07-30T00:00:00Z',
    ...over,
  } as JobRead
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

beforeEach(() => {
  vi.clearAllMocks()
  api.enqueueScan.mockResolvedValue(job({ id: 'scan', job_type: 'scan' }))
  api.enqueueProbe.mockResolvedValue(job({ id: 'probe', job_type: 'probe' }))
  api.enqueueStoryboards.mockResolvedValue(job({ id: 'storyboard', job_type: 'storyboard' }))
})

async function runUpdate(onProgress: (snapshot: JobRead | null) => void) {
  const { result } = renderHook(() => useUpdateLibrary({ onProgress }), { wrapper })
  await act(async () => {
    await result.current.mutateAsync()
  })
}

test('a cancelled background job stops being shown as soon as it settles', async () => {
  // The owner cancelled a storyboard pass and the row stayed on screen reading
  // "Storyboards cancelled 0/50" until a page refresh (2026-07-30). The server
  // had already dropped it — a cancelled job is terminal and leaves the active
  // list — so the only thing still holding the row up was this local snapshot.
  const progress = vi.fn()
  api.enqueueStoryboards.mockResolvedValue(job({ status: 'cancelled' }))

  await runUpdate(progress)

  await waitFor(() => expect(progress).toHaveBeenLastCalledWith(null))
})

test('a failed background job stays on screen', async () => {
  // The opposite case, and the reason the cancelled one was kept too: nobody
  // asked for a failure, and this row carries the only account of it.
  const progress = vi.fn()
  api.enqueueStoryboards.mockResolvedValue(job({ status: 'failed', error: 'ffmpeg not found' }))

  await runUpdate(progress)

  await waitFor(() =>
    expect(progress).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' })),
  )
})

test('grouping opens while metadata continues, then storyboards follow metadata', async () => {
  let finishProbe: (value: JobRead) => void = () => undefined
  api.enqueueScan.mockResolvedValue(
    job({
      id: 'scan',
      job_type: 'scan',
      result: { grouping_plan_id: 'plan1', grouping_proposal_count: 2 },
    }),
  )
  api.enqueueProbe.mockReturnValue(
    new Promise<JobRead>((resolve) => {
      finishProbe = resolve
    }),
  )
  const onGroupingPlan = vi.fn()
  const onProgress = vi.fn()
  const { result } = renderHook(() => useUpdateLibrary({ onGroupingPlan, onProgress }), { wrapper })

  await act(async () => {
    await result.current.mutateAsync()
  })

  expect(onGroupingPlan).toHaveBeenCalledWith('plan1')
  expect(api.enqueueProbe).toHaveBeenCalledWith('lib1')
  expect(api.enqueueStoryboards).not.toHaveBeenCalled()

  await act(async () => {
    finishProbe(job({ id: 'probe', job_type: 'probe' }))
  })

  await waitFor(() => expect(api.enqueueStoryboards).toHaveBeenCalledWith('lib1'))
})

test('metadata failure does not close grouping or start storyboards', async () => {
  api.enqueueScan.mockResolvedValue(
    job({
      id: 'scan',
      job_type: 'scan',
      result: { grouping_plan_id: 'plan1', grouping_proposal_count: 1 },
    }),
  )
  api.enqueueProbe.mockResolvedValue(
    job({ id: 'probe', job_type: 'probe', status: 'failed', error: 'probe failed' }),
  )
  const onGroupingPlan = vi.fn()
  const onProgress = vi.fn()
  const { result } = renderHook(() => useUpdateLibrary({ onGroupingPlan, onProgress }), { wrapper })

  await act(async () => {
    await result.current.mutateAsync()
  })

  expect(onGroupingPlan).toHaveBeenCalledWith('plan1')
  await waitFor(() =>
    expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failed' })),
  )
  expect(api.enqueueStoryboards).not.toHaveBeenCalled()
  expect(result.current.isError).toBe(false)
})

test('scanning for new files does not group, probe, or open the review dialog', async () => {
  // "Scan new files" and "Suggest grouping" are two items in one menu, so the
  // first must not do the second's work. The owner asked for a scan and the
  // grouping review dialog opened at the end of it (2026-08-15).
  const onGroupingPlan = vi.fn()
  const { result } = renderHook(() => useScan({ onGroupingPlan }), { wrapper })

  await act(async () => {
    await result.current.mutateAsync()
  })

  expect(api.enqueueScan).toHaveBeenCalledWith({ suggestGrouping: false })
  expect(onGroupingPlan).not.toHaveBeenCalled()
  expect(api.enqueueProbe).not.toHaveBeenCalled()
  expect(api.enqueueStoryboards).not.toHaveBeenCalled()
})

test('a scan-only job reporting a stale plan still opens nothing', async () => {
  // Belt and braces for the server contract: even if a scan-only run came back
  // naming a plan, this hook has no path that could open it.
  api.enqueueScan.mockResolvedValue(
    job({
      id: 'scan',
      job_type: 'scan',
      result: { grouping_plan_id: 'plan1', grouping_proposal_count: 3 },
    }),
  )
  const onGroupingPlan = vi.fn()
  const { result } = renderHook(() => useScan({ onGroupingPlan }), { wrapper })

  await act(async () => {
    await result.current.mutateAsync()
  })

  expect(onGroupingPlan).not.toHaveBeenCalled()
})

test('a newly created library indexes itself: discovery, then metadata', async () => {
  // Adding a library used to leave every view empty until the owner found two
  // menu items, and playback had no metadata to decide from (2026-08-15).
  const { result } = renderHook(() => useIndexNewLibrary(), { wrapper })

  await act(async () => {
    await result.current.mutateAsync('lib-new')
  })

  // Scoped to the new library, not the active one — the switch may not have
  // settled yet — and with no grouping pass to open a dialog over it.
  expect(api.enqueueScan).toHaveBeenCalledWith({ suggestGrouping: false, libraryId: 'lib-new' })
  expect(api.enqueueProbe).toHaveBeenCalledWith('lib-new')
  // Storyboards stay a deliberate action; they are the expensive one.
  expect(api.enqueueStoryboards).not.toHaveBeenCalled()
})

test('metadata still runs in order after discovery finishes', async () => {
  let finishScan: (value: JobRead) => void = () => undefined
  api.enqueueScan.mockReturnValue(
    new Promise<JobRead>((resolve) => {
      finishScan = resolve
    }),
  )
  const { result } = renderHook(() => useIndexNewLibrary(), { wrapper })

  let done: Promise<unknown> = Promise.resolve()
  await act(async () => {
    done = result.current.mutateAsync('lib-new')
    await Promise.resolve()
  })
  expect(api.enqueueProbe).not.toHaveBeenCalled()

  await act(async () => {
    finishScan(job({ id: 'scan', job_type: 'scan' }))
    await done
  })
  expect(api.enqueueProbe).toHaveBeenCalledWith('lib-new')
})
