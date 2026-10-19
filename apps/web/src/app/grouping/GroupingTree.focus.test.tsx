import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { GroupingTree } from './GroupingTree'
import type { GroupingTreeState } from './useGroupingTree'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

const view = vi.hoisted(() => ({ indices: [0], scroll: vi.fn() }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 72,
    getVirtualItems: () => view.indices.map((index) => ({ index, start: index * 36 })),
    measureElement: () => {},
    scrollToIndex: view.scroll,
  }),
}))
vi.mock('./GroupingNodeRow', () => ({
  GroupingNodeRow: ({ node }: { node: { title: string } }) => <button>{node.title}</button>,
  GroupingCheck: () => null,
}))

afterEach(() => vi.unstubAllGlobals())

test.each([false, true])(
  'delayed virtual focus respects subsequent focus changes (%s)',
  (leave) => {
    view.indices = [0]
    view.scroll.mockClear()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const state = { busy: false, status: { data: {} } } as GroupingWorkspaceState
    const tree = {
      stale: false,
      expanded: new Map(),
      nodes: new Map(),
      toggle: vi.fn(),
      toggleRun: vi.fn(),
      setFileDragging: vi.fn(),
      loadMore: vi.fn(),
      expandCollections: vi.fn(),
      collapseCollections: vi.fn(),
      showFiles: vi.fn(),
      hideFiles: vi.fn(),
      rows: ['Alpha', 'Beta'].map((title, index) => ({
        kind: 'node' as const,
        key: title,
        depth: 0,
        node: {
          id: title,
          title,
          directory: title,
          kind: 'bundle' as const,
          selected: 0,
          files: 1,
          position: index,
          parent: null,
          target: null,
          original_target: null,
          target_title: null,
          collection: null,
          context: false,
          confidence: 1,
          reason: 'Synthetic suggestion',
          bundles: 1,
          children: 0,
          folders: 0,
        },
      })),
    } satisfies GroupingTreeState
    const props = { state, tree, collections: [], onMove: vi.fn() }
    const rendered = render(<GroupingTree {...props} />)
    const alpha = screen.getByRole('treeitem', { name: 'Alpha' })
    act(() => alpha.focus())
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(view.scroll).toHaveBeenCalledWith(1)
    act(() => frames.splice(0).forEach((callback) => callback(0)))
    expect(screen.queryByRole('treeitem', { name: 'Beta' })).not.toBeInTheDocument()
    const outside = document.createElement('button')
    if (leave) {
      document.body.append(outside)
      outside.focus()
    }
    view.indices = [0, 1]
    rendered.rerender(<GroupingTree {...props} />)
    if (leave) expect(screen.getByRole('treeitem', { name: 'Beta' })).not.toHaveFocus()
    else expect(screen.getByRole('treeitem', { name: 'Beta' })).toHaveFocus()
    outside.remove()
  },
)
