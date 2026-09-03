import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { isDesktopHost, setHostNewFolderAvailable } from '../platform'
import { useDesktopNewFolderAvailability } from './useDesktopMenu'

vi.mock('../platform', () => ({
  isDesktopHost: vi.fn(() => true),
  listenHostMenu: vi.fn().mockResolvedValue(() => undefined),
  setHostLibraryAvailable: vi.fn().mockResolvedValue(undefined),
  setHostNewFolderAvailable: vi.fn().mockResolvedValue(undefined),
}))

function Harness({ enabled }: { enabled: boolean }) {
  useDesktopNewFolderAvailability(enabled)
  return null
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(isDesktopHost).mockReturnValue(true)
})

test('follows whether a folder can be created here', async () => {
  const view = render(<Harness enabled={false} />)
  await vi.waitFor(() => expect(setHostNewFolderAvailable).toHaveBeenCalledWith(false))

  view.rerender(<Harness enabled />)
  await vi.waitFor(() => expect(setHostNewFolderAvailable).toHaveBeenLastCalledWith(true))
})

test('greys the item out when the listing goes away', async () => {
  const view = render(<Harness enabled />)
  await vi.waitFor(() => expect(setHostNewFolderAvailable).toHaveBeenCalledWith(true))

  // Leaving the File Browser unmounts the listing; the menu item must not stay
  // live against a directory that is no longer on screen.
  view.unmount()
  expect(setHostNewFolderAvailable).toHaveBeenLastCalledWith(false)
})

test('stays inert in the browser, where there is no menu bar', () => {
  vi.mocked(isDesktopHost).mockReturnValue(false)
  render(<Harness enabled />)
  expect(setHostNewFolderAvailable).not.toHaveBeenCalled()
})
