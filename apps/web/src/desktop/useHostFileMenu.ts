import { useEffect } from 'react'
import { isDesktopHost, setHostFileActionsAvailable } from '../platform'
import type { LibraryHostFiles } from './useLibraryHostFiles'
import { useDesktopMenu } from './useDesktopMenu'
import { isBlockingSurfaceOpen } from './fileDrop'

/** The visible browser owns the native menu's single selected file. */
export function useHostFileMenu(path: string | null, actions: LibraryHostFiles) {
  useDesktopMenu((action) => {
    if (!path || isBlockingSurfaceOpen()) return
    if (action === 'open-file') actions.onOpenFile?.(path)
    if (action === 'reveal-file') actions.onRevealFile?.(path)
  })
  const enabled = Boolean(path && (actions.onOpenFile || actions.onRevealFile))
  useEffect(() => {
    if (!isDesktopHost()) return
    void setHostFileActionsAvailable(enabled).catch(() => undefined)
    return () => {
      void setHostFileActionsAvailable(false).catch(() => undefined)
    }
  }, [enabled])
}
