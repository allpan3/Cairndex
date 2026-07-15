import { useEffect, useRef } from 'react'

import { isDesktopHost, listenDesktopMenu, type DesktopMenuAction } from './runtime'

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
    void listenDesktopMenu((action) => handlerRef.current(action))
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
