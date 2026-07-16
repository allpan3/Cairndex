import { useEffect, useRef } from 'react'

import { isDesktopHost, listenHostMenu, setHostLibraryAvailable } from '../platform'
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
