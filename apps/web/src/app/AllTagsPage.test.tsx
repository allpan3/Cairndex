import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { TagGroupRead, TagRead } from '../api/client'
import { AllTagsPage } from './AllTagsPage'

const hooks = vi.hoisted(() => ({
  tags: [] as unknown[],
  groups: [] as unknown[],
  memberships: {} as Record<string, string[]>,
  counts: {} as Record<string, number>,
  tagMutations: {
    rename: { mutate: vi.fn() },
    remove: { mutate: vi.fn(), isPending: false },
    reparent: { mutate: vi.fn() },
  },
  groupMutations: {
    create: { mutate: vi.fn() },
    rename: { mutate: vi.fn() },
    remove: { mutate: vi.fn(), isPending: false },
    addTag: { mutate: vi.fn() },
    removeTag: { mutate: vi.fn() },
  },
  createTagPath: { mutate: vi.fn() },
}))

vi.mock('../api/hooks', () => ({
  useTags: () => ({ data: hooks.tags }),
  useTagGroups: () => ({ data: hooks.groups }),
  useTagGroupMemberships: () => ({ data: hooks.memberships }),
  useTagCounts: () => ({ data: hooks.counts }),
  useTagMutations: () => hooks.tagMutations,
  useTagGroupMutations: () => hooks.groupMutations,
  useCreateTagPath: () => hooks.createTagPath,
}))

vi.mock('../api/client', () => ({
  fetchTagDeleteImpact: vi.fn(async () => ({ tags: 1, bundles: 0 })),
}))

function tag(id: string, name: string, parentId: string | null = null): TagRead {
  return {
    id,
    name,
    parent_id: parentId,
    color: null,
    version: 1,
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
  } as TagRead
}

function group(id: string, name: string): TagGroupRead {
  return {
    id,
    name,
    sort_order: 0,
    created_at: '2026-08-23T00:00:00Z',
    updated_at: '2026-08-23T00:00:00Z',
  } as TagGroupRead
}

beforeEach(() => {
  vi.clearAllMocks()
  hooks.tags = [tag('studio', 'Studio'), tag('series', 'Series', 'studio'), tag('mood', 'Mood')]
  hooks.groups = [group('shelf', 'Shelf')]
  hooks.memberships = { shelf: ['mood'] }
  hooks.counts = { studio: 2, series: 3, mood: 1 }
})

/** Right-click a tag tile by name and return the menu items it offers. */
function openTagMenu(name: string): HTMLElement[] {
  fireEvent.contextMenu(screen.getByText(name))
  return screen.getAllByRole('menuitem')
}

test('creates a top-level tag from the toolbar, reading / as a hierarchy divider', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: 'New Tag' }))
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Label/Imprint' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(hooks.createTagPath.mutate).toHaveBeenCalledWith(
    { path: 'Label/Imprint', existing: hooks.tags, parentId: null },
    expect.anything(),
  )
})

test('creates a child tag beneath the tag whose menu it came from', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  const items = openTagMenu('Studio')
  const newChild = items.find((item) => item.textContent === 'New Child Tag')
  if (!newChild) throw new Error('expected a New Child Tag entry')
  fireEvent.click(newChild)

  expect(screen.getByRole('dialog', { name: 'New Tag in “Studio”' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Season' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(hooks.createTagPath.mutate).toHaveBeenCalledWith(
    { path: 'Season', existing: hooks.tags, parentId: 'studio' },
    expect.anything(),
  )
})

test('a tag created while a group panel is open joins that group', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: /^Shelf/ }))

  fireEvent.click(screen.getByRole('button', { name: 'New Tag' }))
  fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Fresh' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  // The page hands the group join to the mutation's own success callback, so the
  // tag exists before anything tries to file it.
  const [, options] = hooks.createTagPath.mutate.mock.calls[0] as [
    unknown,
    { onSuccess: (tag: TagRead) => void },
  ]
  options.onSuccess(tag('fresh', 'Fresh'))
  expect(hooks.groupMutations.addTag.mutate).toHaveBeenCalledWith({
    groupId: 'shelf',
    tagId: 'fresh',
  })
})

test('creates a tag group from the side rail', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  fireEvent.click(screen.getByRole('button', { name: 'New tag group' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Format' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create' }))

  expect(hooks.groupMutations.create.mutate).toHaveBeenCalledWith('Format', expect.anything())
})

test('renames and deletes a tag group from its row, and says the tags survive', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)
  const row = screen.getByRole('button', { name: /^Shelf/ })

  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Rename Group' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Bookshelf' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
  expect(hooks.groupMutations.rename.mutate).toHaveBeenCalledWith(
    { id: 'shelf', name: 'Bookshelf' },
    expect.anything(),
  )

  fireEvent.contextMenu(row)
  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete Group' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete Tag Group' })
  expect(dialog).toHaveTextContent('Its one tag stays')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
  expect(hooks.groupMutations.remove.mutate).toHaveBeenCalledWith('shelf', expect.anything())
})

test('offers group membership both ways from a tag’s menu', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  const notMember = openTagMenu('Studio').map((item) => item.textContent)
  expect(notMember).toContain('Add to Shelf')
  fireEvent.keyDown(window, { key: 'Escape' })

  const member = openTagMenu('Mood')
  expect(member.map((item) => item.textContent)).toContain('Remove from Shelf')
  const remove = member.find((item) => item.textContent === 'Remove from Shelf')
  if (!remove) throw new Error('expected a Remove from Shelf entry')
  fireEvent.click(remove)
  expect(hooks.groupMutations.removeTag.mutate).toHaveBeenCalledWith({
    groupId: 'shelf',
    tagId: 'mood',
  })
})

test('dragging a tag onto a group row adds it to the group without reparenting it', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)
  const tile = screen.getByText('Studio').closest('.tagtile')
  if (!(tile instanceof HTMLElement)) throw new Error('expected a tag tile')
  const row = screen.getByRole('button', { name: /^Shelf/ })

  fireEvent.dragStart(tile)
  fireEvent.dragOver(row)
  expect(row.className).toContain('alltags__nav--drop')
  fireEvent.drop(row)

  expect(hooks.groupMutations.addTag.mutate).toHaveBeenCalledWith(
    { groupId: 'shelf', tagId: 'studio' },
    expect.anything(),
  )
  expect(hooks.tagMutations.reparent.mutate).not.toHaveBeenCalled()
})

test('a group row offers no drop cue for a tag it already holds', () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)
  const tile = screen.getByText('Mood').closest('.tagtile')
  if (!(tile instanceof HTMLElement)) throw new Error('expected a tag tile')
  const row = screen.getByRole('button', { name: /^Shelf/ })

  fireEvent.dragStart(tile)
  fireEvent.dragOver(row)
  expect(row.className).not.toContain('alltags__nav--drop')
})

test('expands and collapses every tag with children in one action', async () => {
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  expect(screen.queryByText('Series')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Expand all' }))
  expect(screen.getByText('Series')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }))
  await waitFor(() => expect(screen.queryByText('Series')).not.toBeInTheDocument())
})

test('has nothing to expand when no tag in scope has children', () => {
  hooks.tags = [tag('mood', 'Mood')]
  render(<AllTagsPage onApplyTagFilter={vi.fn()} />)

  expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled()
})
