import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { grouping, type GroupingNode, type GroupingStatus } from '../../api/grouping'
import { useGroupingTree } from './useGroupingTree'

vi.mock('../../api/grouping', () => ({ grouping: vi.fn() }))

function node(id: string): GroupingNode {
  return {
    id,
    parent: null,
    kind: 'bundle',
    title: id,
    directory: '',
    target: null,
    original_target: null,
    target_title: null,
    collection: null,
    context: false,
    position: 0,
    confidence: 1,
    reason: 'Synthetic',
    files: 1,
    selected: 1,
    bundles: 1,
    children: 0,
    folders: 0,
    media_counts: { video: 1 },
  }
}

it('retains loaded rows while edits refresh fresh cursors and isolates another workspace', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const calls: { workspace: string; revision: number; after: string }[] = []
  let resume: (() => void) | undefined
  const paused = new Promise<void>((resolve) => {
    resume = resolve
  })
  vi.mocked(grouping).mockImplementation(async (_library, path) => {
    const url = new URL(path, 'http://synthetic.invalid')
    const revision = Number(url.searchParams.get('revision'))
    const after = url.searchParams.get('after')!
    const workspace = url.pathname.split('/')[2]!
    calls.push({ workspace, revision, after })
    if (revision === 2 && workspace === 'first') await paused
    return {
      revision,
      items: [node(`${workspace}-${revision}-${after}`)],
      next_cursor: after === '-1' ? (revision === 1 ? 11 : 21) : null,
    }
  })
  const source = (workspace: string, revision: number) => ({
    library: 'synthetic',
    scope: 'local',
    workspace,
    status: {
      data: {
        id: workspace,
        state: 'ready',
        phase: 'ready',
        revision,
        accepting: null,
        error: null,
        files: 2,
        selected: 2,
        bundles: 2,
        uncertain: 0,
        command: null,
      } as GroupingStatus,
    },
  })
  const { result, rerender, unmount } = renderHook(
    ({ workspace, revision }) => useGroupingTree(source(workspace, revision), false),
    {
      initialProps: { workspace: 'first', revision: 1 },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  try {
    await waitFor(() => expect(result.current.stale).toBe(false))
    const more = result.current.rows.find((row) => row.kind === 'more')!
    if (more.kind !== 'more') throw new Error('Expected a next page')
    act(() => result.current.loadMore(more.scope))
    await waitFor(() =>
      expect(result.current.rows.filter((row) => row.kind === 'node')).toHaveLength(2),
    )
    rerender({ workspace: 'first', revision: 2 })
    expect(result.current.stale).toBe(true)
    expect(result.current.rows.filter((row) => row.kind === 'node')).toHaveLength(2)
    await act(async () => resume?.())
    await waitFor(() => expect(result.current.stale).toBe(false))
    expect(
      calls
        .filter((call) => call.workspace === 'first' && call.revision === 2)
        .map((call) => call.after),
    ).toEqual(['-1', '21'])
    rerender({ workspace: 'second', revision: 2 })
    await waitFor(() => expect(result.current.stale).toBe(false))
    expect(result.current.rows.filter((row) => row.kind === 'node')).toHaveLength(1)
    expect(calls.filter((call) => call.workspace === 'second').map((call) => call.after)).toEqual([
      '-1',
    ])
  } finally {
    unmount()
    client.clear()
    vi.resetAllMocks()
  }
})

it('reveals rollups during a file drag and applies Show files to new pages while retaining individual folds', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(grouping).mockImplementation(async (_library, path) => {
    const url = new URL(path, 'http://synthetic.invalid')
    if (!url.pathname.endsWith('/nodes')) return { revision: 1, items: [], next_cursor: null }
    const first = url.searchParams.get('after') === '-1'
    return {
      revision: 1,
      items: (first ? ['one', 'two', 'three'] : ['four']).map(node),
      next_cursor: first ? 3 : null,
    }
  })
  const { result, unmount } = renderHook(
    () =>
      useGroupingTree(
        {
          library: 'synthetic',
          scope: 'local',
          workspace: 'draft',
          status: {
            data: {
              id: 'draft',
              state: 'ready',
              phase: 'ready',
              revision: 1,
              files: 4,
              selected: 4,
              bundles: 4,
              uncertain: 0,
              accepting: null,
              error: null,
              command: null,
            },
          },
        },
        false,
      ),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  )
  try {
    await waitFor(() => expect(result.current.stale).toBe(false))
    expect(result.current.rows[0]?.kind).toBe('rollup')
    act(() => result.current.setFileDragging(true))
    expect(result.current.stale).toBe(false)
    await waitFor(() => expect(result.current.stale).toBe(false))
    expect(result.current.rows.filter((row) => row.kind === 'node')).toHaveLength(3)
    expect(result.current.expanded.size).toBe(3)
    act(() => result.current.setFileDragging(false))
    expect(result.current.rows[0]?.kind).toBe('rollup')
    expect(result.current.expanded.size).toBe(0)
    act(() => result.current.showFiles())
    await waitFor(() => expect(result.current.stale).toBe(false))
    act(() => result.current.toggle(node('one')))
    expect(result.current.expanded.has('one')).toBe(false)
    const more = result.current.rows.find((row) => row.kind === 'more')!
    if (more.kind !== 'more') throw new Error('Expected a next page')
    act(() => result.current.loadMore(more.scope))
    await waitFor(() => expect(result.current.expanded.has('four')).toBe(true))
    expect(result.current.expanded.has('one')).toBe(false)
    act(() => result.current.hideFiles())
    expect(result.current.expanded.size).toBe(0)
    expect(result.current.rows[0]?.kind).toBe('rollup')
  } finally {
    unmount()
    client.clear()
    vi.resetAllMocks()
  }
})
