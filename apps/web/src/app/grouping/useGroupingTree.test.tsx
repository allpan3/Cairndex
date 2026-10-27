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

it('pages additions as their own section on grouping_version 2 and keeps the mixed tree before it', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const calls: string[] = []
  vi.mocked(grouping).mockImplementation(async (_library, path) => {
    const url = new URL(path, 'http://synthetic.invalid')
    calls.push(`${url.pathname.split('/').at(-1)}?${url.searchParams}`)
    const after = url.searchParams.get('after')
    if (url.pathname.endsWith('/additions')) {
      const first = after === ''
      return {
        revision: 1,
        items: (first ? ['added-one'] : ['added-two']).map((id) => ({
          ...node(id),
          target: `bundle-${id}`,
          original_target: `bundle-${id}`,
          target_title: `Existing ${id}`,
        })),
        next_cursor: first ? 'added-one' : null,
      }
    }
    if (url.pathname.endsWith('/nodes') || url.pathname.endsWith('/attention'))
      return { revision: 1, items: [node('new-bundle')], next_cursor: null }
    return { revision: 1, items: [], next_cursor: null }
  })
  const source = {
    library: 'synthetic',
    scope: 'local',
    workspace: 'draft',
    status: {
      data: {
        id: 'draft',
        state: 'ready',
        phase: 'ready',
        revision: 1,
        files: 3,
        selected: 3,
        bundles: 3,
        uncertain: 0,
        accepting: null,
        error: null,
        command: null,
      } as GroupingStatus,
    },
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const sections = (rows: { kind: string; key: string }[]) =>
    rows.map((row) => (row.kind === 'node' || row.kind === 'section' ? row.key : row.kind))
  try {
    const separated = renderHook(({ attention }) => useGroupingTree(source, attention, true), {
      initialProps: { attention: false },
      wrapper,
    })
    await waitFor(() => expect(separated.result.current.stale).toBe(false))
    expect(sections(separated.result.current.rows)).toEqual([
      'section:additions',
      'added-one',
      'more',
      'section:suggestions',
      'new-bundle',
    ])
    expect(separated.result.current.sectioned).toBe(true)
    expect(calls).toContain('additions?revision=1&after=')
    expect(calls).toContain('nodes?revision=1&after=-1&exclude_additions=true')
    // Later additions pages follow the string cursor inside their own section
    const more = separated.result.current.rows.find((row) => row.kind === 'more')!
    if (more.kind !== 'more') throw new Error('Expected a next page')
    act(() => separated.result.current.loadMore(more.scope))
    await waitFor(() =>
      expect(sections(separated.result.current.rows)).toEqual([
        'section:additions',
        'added-one',
        'added-two',
        'section:suggestions',
        'new-bundle',
      ]),
    )
    expect(calls).toContain('additions?revision=1&after=added-one')
    const heading = separated.result.current.rows[0]!
    expect(heading.kind === 'section' && heading.complete).toBe(true)
    act(() => separated.result.current.toggleSection('additions', false))
    expect(sections(separated.result.current.rows)).toEqual([
      'section:additions',
      'section:suggestions',
      'new-bundle',
    ])
    // The uncertainty filter narrows both sections on the server
    separated.rerender({ attention: true })
    await waitFor(() => expect(calls).toContain('additions?revision=1&after=&uncertain=true'))
    expect(calls).toContain('attention?revision=1&after=&exclude_additions=true')
    separated.unmount()
    // A grouping_version 1 server is never asked for the new route or parameters
    calls.length = 0
    client.clear()
    const mixed = renderHook(() => useGroupingTree(source, false), { wrapper })
    await waitFor(() => expect(mixed.result.current.stale).toBe(false))
    expect(sections(mixed.result.current.rows)).toEqual(['new-bundle'])
    expect(calls).toContain('nodes?revision=1&after=-1')
    expect(calls.filter((call) => call.includes('additions'))).toEqual([])
    mixed.unmount()
  } finally {
    client.clear()
    vi.resetAllMocks()
  }
})

it('draws neither section before both first pages arrive and leaves out an empty section', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release: (() => void) | undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let additions = ['added-one']
  let suggestions: string[] = []
  vi.mocked(grouping).mockImplementation(async (_library, path) => {
    const url = new URL(path, 'http://synthetic.invalid')
    if (url.pathname.endsWith('/additions'))
      return {
        revision: 1,
        items: additions.map((id) => ({ ...node(id), target: 'bundle-one', target_title: 'One' })),
        next_cursor: null,
      }
    if (url.pathname.endsWith('/nodes')) {
      await held
      return { revision: 1, items: suggestions.map(node), next_cursor: null }
    }
    return { revision: 1, items: [], next_cursor: null }
  })
  const source = {
    library: 'synthetic',
    scope: 'local',
    workspace: 'draft',
    status: {
      data: {
        id: 'draft',
        state: 'ready',
        phase: 'ready',
        revision: 1,
        files: 1,
        selected: 1,
        bundles: 1,
        uncertain: 0,
        accepting: null,
        error: null,
        command: null,
      } as GroupingStatus,
    },
  }
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const keys = (rows: { kind: string; key: string }[]) =>
    rows.map((row) => (row.kind === 'node' || row.kind === 'section' ? row.key : row.kind))
  try {
    const additionsKey = ['grouping-tree', 'local', 'synthetic', 'draft', 'additions', '', true]
    const first = renderHook(() => useGroupingTree(source, false, true), { wrapper })
    // The additions page is in while the tree's first page is still on its way
    await waitFor(() => expect(client.getQueryData(additionsKey)).toBeDefined())
    expect(keys(first.result.current.rows)).toEqual(['loading'])
    expect(first.result.current.sectioned).toBe(false)
    await act(async () => release?.())
    await waitFor(() => expect(first.result.current.stale).toBe(false))
    // A tree with no new work has no heading of its own
    expect(keys(first.result.current.rows)).toEqual(['section:additions', 'added-one'])
    first.unmount()
    client.clear()
    // Without additions the tree is drawn as it always was, with no headings
    additions = []
    suggestions = ['new-bundle']
    const second = renderHook(() => useGroupingTree(source, false, true), { wrapper })
    await waitFor(() => expect(second.result.current.stale).toBe(false))
    expect(keys(second.result.current.rows)).toEqual(['new-bundle'])
    expect(second.result.current.sectioned).toBe(false)
    second.unmount()
  } finally {
    client.clear()
    vi.resetAllMocks()
  }
})
