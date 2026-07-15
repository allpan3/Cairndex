import { useEffect, useRef } from 'react'

import type { DesktopMenuAction } from './types'

// Detects the native host without importing Tauri into browser bundles
function isDesktopHost(): boolean {
  return '__TAURI_INTERNALS__' in window
}

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
    void import('./runtime')
      .then(({ listenDesktopMenu }) => listenDesktopMenu((action) => handlerRef.current(action)))
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

// Synchronizes availability of workspace-only native menu actions
export function useDesktopMenuAvailability(enabled: boolean): void {
  useEffect(() => {
    if (!isDesktopHost()) return
    void import('./runtime')
      .then(({ setDesktopLibraryAvailable }) => setDesktopLibraryAvailable(enabled))
      .catch(() => undefined)
  }, [enabled])
}
