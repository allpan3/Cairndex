import { useEffect, useRef } from 'react'

import {
  isDesktopHost,
  listenHostMenu,
  setHostLibraryAvailable,
  setHostNewFolderAvailable,
} from '../platform'
import type { DesktopMenuAction } from './types'

// Routes native menu events to the latest mounted SPA handler
export function useDesktopMenu(handler: (action: DesktopMenuAction) => void): void {
  const handlerRef = useRef(handler)

  useEffect(() => {
    handlerRef.current = handler
  }, [handler])

  useEffect(() => {
    if (!isDesktopHost()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listenHostMenu((action) => handlerRef.current(action))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => console.error('Could not start desktop menu handling', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}

// Synchronizes availability of workspace-only native menu actions
export function useDesktopMenuAvailability(enabled: boolean): void {
  useEffect(() => {
    if (!isDesktopHost()) return
    void setHostLibraryAvailable(enabled).catch((error: unknown) =>
      console.error('Could not update desktop menu availability', error),
    )
  }, [enabled])
}

/**
 * Keeps File ▸ New Folder enabled only while the File Browser is showing a
 * directory a folder can be created in. Owned by the listing rather than the
 * shell root, because that is where the capability is known — and unmounting the
 * listing (leaving the File Browser) is itself a reason to grey the item out.
 */
export function useDesktopNewFolderAvailability(enabled: boolean): void {
  useEffect(() => {
    if (!isDesktopHost()) return
    void setHostNewFolderAvailable(enabled).catch((error: unknown) =>
      console.error('Could not update the desktop New Folder item', error),
    )
  }, [enabled])

  useEffect(() => {
    if (!isDesktopHost()) return
    return () => {
      void setHostNewFolderAvailable(false).catch((error: unknown) =>
        console.error('Could not disable the desktop New Folder item', error),
      )
    }
  }, [])
}
