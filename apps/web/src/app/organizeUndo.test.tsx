import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, expect, test, vi } from 'vitest'

import { reverseChanges, type MembershipChange } from '../api/catalogUndo'
import type { CatalogNotice } from './CatalogToast'
import { membershipText, useOrganizeUndoStack } from './organizeUndo'

vi.mock('../api/catalogUndo', () => ({ reverseChanges: vi.fn() }))

const change = (ids: string[]): MembershipChange => ({
  family: 'tags',
  target: 'synthetic-tag',
  assigned: true,
  ids,
})

function setup() {
  const notices: CatalogNotice[] = []
  const client = new QueryClient()
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  const hook = renderHook(
    ({ library }) => useOrganizeUndoStack(library, (notice) => notices.push(notice)),
    { wrapper, initialProps: { library: 'library' } },
  )
  return { ...hook, notices }
}

beforeEach(() => {
  vi.mocked(reverseChanges).mockReset().mockResolvedValue()
  document.body.innerHTML = ''
})

test('a recorded change offers Undo, which reverses it and reports so', async () => {
  const { result, notices } = setup()
  act(() => result.current.record('Added “Synthetic” to 2 bundles.', [change(['a', 'b'])]))
  expect(notices[0]).toMatchObject({ text: 'Added “Synthetic” to 2 bundles.' })
  act(() => notices[0]!.action!.run())
  await waitFor(() => expect(notices[1]?.text).toBe('Undone: Added “Synthetic” to 2 bundles.'))
  expect(reverseChanges).toHaveBeenCalledWith('library', [change(['a', 'b'])])
})

test('a change that altered nothing, or could not be read, offers no Undo', () => {
  const { result, notices } = setup()
  act(() => result.current.record('Nothing new.', [change([])]))
  act(() => result.current.record('Unread.', [change(['a']), null]))
  expect(notices.map((notice) => notice.action)).toEqual([undefined, undefined])
  expect(result.current.newest()).toBeNull()
})

test('⌘Z gets the latest change, then the one before it', async () => {
  const { result } = setup()
  act(() => result.current.record('First.', [change(['a'])]))
  act(() => result.current.record('Second.', [change(['b'])]))
  const second = result.current.newest()!
  act(() => second.run())
  await waitFor(() => expect(reverseChanges).toHaveBeenCalledTimes(1))
  expect(vi.mocked(reverseChanges).mock.calls[0]![1]).toEqual([change(['b'])])
  const first = result.current.newest()!
  expect(first.at).toBeLessThan(second.at)
  act(() => first.run())
  await waitFor(() => expect(reverseChanges).toHaveBeenCalledTimes(2))
  expect(vi.mocked(reverseChanges).mock.calls[1]![1]).toEqual([change(['a'])])
  expect(result.current.newest()).toBeNull()
})

test('⌘Z leaves changes in another library alone; their message still undoes them there', async () => {
  const { result, rerender, notices } = setup()
  act(() => result.current.record('Elsewhere.', [change(['a'])]))
  rerender({ library: 'other' })
  expect(result.current.newest()).toBeNull()
  act(() => notices[0]!.action!.run())
  await waitFor(() => expect(reverseChanges).toHaveBeenCalledWith('library', [change(['a'])]))
})

test('a refused undo reports the refusal', async () => {
  vi.mocked(reverseChanges).mockRejectedValue(new Error('Changed on another device.'))
  const { result, notices } = setup()
  act(() => result.current.record('Moved.', [change(['a'])]))
  act(() => notices[0]!.action!.run())
  await waitFor(() =>
    expect(notices[1]).toEqual({ text: 'Changed on another device.', alert: true }),
  )
})

test('messages count bundles and name the destination', () => {
  expect(membershipText('tags', 'Synthetic', true, 1)).toBe('Added “Synthetic” to 1 bundle.')
  expect(membershipText('collections', 'Synthetic', false, 3)).toBe(
    'Removed 3 bundles from “Synthetic”.',
  )
})
