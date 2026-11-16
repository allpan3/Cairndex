import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { TagPickerPanel } from './TagPickerPanel'
import { CatalogQueryContext } from '../api/catalogQuery'
import { advanceConnectionScope } from '../api/requestScope'

vi.mock('../api/hooks', () => ({
  useTags: () => ({
    data: [
      { id: 'parent', name: 'Genre', parent_id: null },
      { id: 'child', name: 'Noir', parent_id: 'parent' },
    ],
  }),
  useTagCounts: () => ({ data: {} }),
  useTagGroups: () => ({ data: [] }),
  useTagGroupMemberships: () => ({ data: {} }),
  useCreateTagPath: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('./pinyin', () => ({
  usePinyinSearch: (search: string) => (value: string) =>
    value.toLowerCase().includes(search.toLowerCase()),
}))
beforeEach(() => {
  sessionStorage.clear()
  advanceConnectionScope('test-server')
})
function picker(library = 'library-one', assigned = new Set<string>()) {
  const toggle = vi.fn()
  const view = render(
    <CatalogQueryContext.Provider value={library}>
      <TagPickerPanel assigned={assigned} onToggle={toggle} onCreated={vi.fn()} />
    </CatalogQueryContext.Provider>,
  )
  return { ...view, toggle }
}
test('arrow keys reach visible tags and return to search; selected filter keeps paths', () => {
  picker('library-one', new Set(['child']))
  fireEvent.click(screen.getByRole('button', { name: 'Selected' }))
  const search = screen.getByRole('textbox', { name: 'Search tags' })
  fireEvent.keyDown(search, { key: 'ArrowDown' })
  expect(screen.getByRole('button', { name: /Genre\/Noir/ })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(search).toHaveFocus()
  expect(screen.getByText('↑↓ move · ↵ select · Esc close')).toBeVisible()
})
test('recent choices survive reopening and stay scoped to their library and server', () => {
  const first = picker()
  fireEvent.click(screen.getByRole('button', { name: /Noir/ }))
  expect(first.toggle).toHaveBeenCalledWith('child', true)
  first.unmount()
  const again = picker()
  fireEvent.click(screen.getByRole('button', { name: 'Recently Used' }))
  expect(screen.getByRole('button', { name: /Genre\/Noir/ })).toBeVisible()
  again.unmount()
  const other = picker('library-two')
  fireEvent.click(screen.getByRole('button', { name: 'Recently Used' }))
  expect(screen.getByText('No matching tags')).toBeVisible()
  other.unmount()
  advanceConnectionScope('other-server')
  picker()
  fireEvent.click(screen.getByRole('button', { name: 'Recently Used' }))
  expect(screen.getByText('No matching tags')).toBeVisible()
})
