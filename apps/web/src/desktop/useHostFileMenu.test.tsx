import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'
import { useHostFileMenu } from './useHostFileMenu'
import type { LibraryHostFiles } from './useLibraryHostFiles'
import { setHostFileActionsAvailable } from '../platform'

const native = vi.hoisted(() => ({
  handler: (_action: string) => {
    void _action
  },
  desktop: true,
}))
vi.mock('./useDesktopMenu', () => ({
  useDesktopMenu: (handler: (action: string) => void) => {
    native.handler = handler
  },
}))
vi.mock('../platform', () => ({
  isDesktopHost: () => native.desktop,
  setHostFileActionsAvailable: vi.fn().mockResolvedValue(undefined),
}))
const actions = { onOpenFile: vi.fn(), onRevealFile: vi.fn() } as unknown as LibraryHostFiles
function Harness({ path }: { path: string | null }) {
  useHostFileMenu(path, actions)
  return null
}
beforeEach(() => {
  vi.clearAllMocks()
  native.desktop = true
})
test('native commands follow the visible selection and disable after unmount', () => {
  const view = render(<Harness path="amber.txt" />)
  expect(setHostFileActionsAvailable).toHaveBeenLastCalledWith(true)
  native.handler('open-file')
  expect(actions.onOpenFile).toHaveBeenLastCalledWith('amber.txt')
  view.rerender(<Harness path="blue.txt" />)
  native.handler('reveal-file')
  expect(actions.onRevealFile).toHaveBeenLastCalledWith('blue.txt')
  view.rerender(<Harness path={null} />)
  native.handler('open-file')
  expect(actions.onOpenFile).toHaveBeenCalledTimes(1)
  expect(setHostFileActionsAvailable).toHaveBeenLastCalledWith(false)
  view.unmount()
  expect(setHostFileActionsAvailable).toHaveBeenLastCalledWith(false)
})
test('a dialog blocks the selected file and plain web has no native menu', () => {
  native.desktop = false
  render(<Harness path="amber.txt" />)
  expect(setHostFileActionsAvailable).not.toHaveBeenCalled()
  const modal = document.createElement('div')
  modal.setAttribute('aria-modal', 'true')
  document.body.append(modal)
  native.handler('reveal-file')
  expect(actions.onRevealFile).not.toHaveBeenCalled()
  modal.remove()
})
