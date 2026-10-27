import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import type { GroupingNode } from '../../api/grouping'
import { GroupingTree } from './GroupingTree'
import type { GroupingTreeState, TreeRow } from './useGroupingTree'
import type { GroupingWorkspaceState } from './useGroupingWorkspace'

const view = vi.hoisted(() => ({ renamed: [] as string[] }))
// Every row is drawn, so keyboard moves land on mounted rows
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 36,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 36 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))
vi.mock('./GroupingNodeRow', () => ({
  GroupingNodeRow: ({ node }: { node: { id: string; title: string } }) => (
    <>
      <button className="grp-title grp-title--editable" onClick={() => view.renamed.push(node.id)}>
        {node.title}
      </button>
      <button>Placement</button>
    </>
  ),
  GroupingCheck: () => null,
}))

function node(id: string, kind: GroupingNode['kind'], target: string | null = null): GroupingNode {
  return {
    id,
    parent: null,
    kind,
    title: id,
    directory: id,
    target,
    original_target: target,
    target_title: target,
    collection: null,
    context: false,
    position: 0,
    confidence: 1,
    reason: 'Synthetic suggestion',
    files: 2,
    selected: 0,
    bundles: 1,
    children: 0,
    folders: 0,
  }
}

function setup(separate: boolean) {
  const edit = vi.fn()
  const toggleSection = vi.fn()
  const addition = node('Synthetic addition', 'bundle', 'Synthetic existing bundle')
  const collection = node('Synthetic collection', 'container')
  const rows: TreeRow[] = separate
    ? [
        {
          kind: 'section',
          key: 'section:additions',
          depth: 0,
          section: 'additions',
          open: true,
          nodes: [addition],
          complete: true,
        },
        { kind: 'node', key: addition.id, depth: 0, node: addition },
        {
          kind: 'section',
          key: 'section:suggestions',
          depth: 0,
          section: 'suggestions',
          open: true,
          nodes: [],
          complete: false,
        },
        { kind: 'node', key: collection.id, depth: 0, node: collection },
      ]
    : [{ kind: 'node', key: collection.id, depth: 0, node: collection }]
  const state = {
    busy: false,
    edit,
    status: { data: { accepting: null } },
  } as unknown as GroupingWorkspaceState
  const tree = {
    rows,
    stale: false,
    expanded: new Map(),
    nodes: new Map(),
    toggle: vi.fn(),
    toggleRun: vi.fn(),
    toggleSection,
    separate,
    sectioned: separate,
    filesShown: false,
    setFileDragging: vi.fn(),
    loadMore: vi.fn(),
    expandCollections: vi.fn(),
    collapseCollections: vi.fn(),
    showFiles: vi.fn(),
    hideFiles: vi.fn(),
  } satisfies GroupingTreeState
  render(<GroupingTree state={state} tree={tree} collections={[]} onMove={vi.fn()} />)
  return { edit, toggleSection, items: screen.getAllByRole('treeitem') }
}

test('sections nest their rows and select a collection apart from the additions', () => {
  const { edit, items } = setup(true)
  expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1', '2', '1', '2'])
  expect(items[0]).toHaveAttribute('aria-expanded', 'true')
  fireEvent.keyDown(items[3]!, { key: ' ' })
  expect(edit).toHaveBeenLastCalledWith({
    action: 'select',
    node: 'Synthetic collection',
    selected: true,
    exclude_additions: true,
  })
  // A complete additions section is selected as one command
  fireEvent.keyDown(items[0]!, { key: ' ' })
  expect(edit).toHaveBeenLastCalledWith({
    action: 'select',
    nodes: ['Synthetic addition'],
    selected: true,
  })
})

test('Left from a top-level row reaches its section heading, which then folds', () => {
  const { toggleSection, items } = setup(true)
  act(() => items[3]!.focus())
  fireEvent.keyDown(items[3]!, { key: 'ArrowLeft' })
  expect(items[2]).toHaveFocus()
  fireEvent.keyDown(items[2]!, { key: 'ArrowLeft' })
  expect(toggleSection).toHaveBeenCalledWith('suggestions', false)
})

test('Enter renames from the row itself and leaves its buttons their own Enter', () => {
  view.renamed = []
  const { items } = setup(true)
  const placement = within(items[3]!).getByRole('button', { name: 'Placement' })
  expect(fireEvent.keyDown(placement, { key: 'Enter' })).toBe(true)
  expect(view.renamed).toEqual([])
  fireEvent.keyDown(items[3]!, { key: 'Enter' })
  fireEvent.keyDown(placement, { key: 'F2' })
  expect(view.renamed).toEqual(['Synthetic collection', 'Synthetic collection'])
})

test('Shift+F10 opens the row menu, which takes focus, moves by arrows and closes on Tab', () => {
  const { items } = setup(true)
  act(() => items[3]!.focus())
  fireEvent.keyDown(items[3]!, { key: 'F10', shiftKey: true })
  const menu = screen.getByRole('menu')
  const options = within(menu).getAllByRole('menuitem')
  expect(options.map((item) => item.textContent)).toEqual([
    'Rename',
    'Convert to bundle',
    'Move to…',
  ])
  expect(options[0]).toHaveFocus()
  fireEvent.keyDown(options[0]!, { key: 'ArrowUp' })
  expect(options[2]).toHaveFocus()
  fireEvent.keyDown(options[2]!, { key: 'Tab' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(items[3]).toHaveFocus()
})

test('the mixed tree of an older server selects a collection without the new flag', () => {
  const { edit, items } = setup(false)
  expect(items.map((item) => item.getAttribute('aria-level'))).toEqual(['1'])
  fireEvent.keyDown(items[0]!, { key: ' ' })
  expect(edit).toHaveBeenLastCalledWith({
    action: 'select',
    node: 'Synthetic collection',
    selected: true,
  })
})
