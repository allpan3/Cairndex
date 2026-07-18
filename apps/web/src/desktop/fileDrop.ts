import { useEffect, useRef } from 'react'

import {
  hostOperationErrorMessage,
  isDesktopHost,
  listenHostFileDrop,
  type ReverseMapResult,
} from '../platform'

// Shown when files land inside the active library and can be bundled in place.
// Reuses the existing fast-add flow (Create Bundle from the dropped paths).
export const DROP_UNMAPPED_MESSAGE =
  'Locate this library on this computer first (Settings → Libraries) to add files by dragging them in.'

// The active library is mapped, but the dropped files live outside its folder.
// Cairndex links files in place, so there is nothing to link until they are moved
// in (or, once plan 4 W5 lands, copied in — see onCopyIntoLibrary below).
export const DROP_OUTSIDE_MESSAGE =
  'Cairndex links files in place — move them into this library’s folder first, then drag them in.'

// Some dropped files were inside the library (added) and some were outside.
export function droppedPartialOutsideMessage(outsideCount: number): string {
  const files = outsideCount === 1 ? 'file was' : 'files were'
  return `${outsideCount} ${files} outside this library and ${outsideCount === 1 ? 'was' : 'were'} not added.`
}

/** Everything the drop router needs; injected so the routing is unit-testable. */
export interface FileDropRouting {
  libraryId: string
  // Whether the active library is located on this computer (has a local mapping).
  libraryMapped: boolean
  reverseMap: (libraryId: string, paths: string[]) => Promise<ReverseMapResult>
  // Hand the in-library relative paths to the existing fast-add / manual-bundling
  // flow (opens Create Bundle seeded with these files).
  onFastAdd: (relativePaths: string[]) => void
  onFlash: (message: string) => void
  /**
   * Plan 4 W5 seam. Dropping files from *outside* the library is the owner's
   * driving use case for write mode: W5 will replace the "move it in first"
   * explanation with a "Copy into library…" flow that streams the local files to
   * the server's journaled write path. Providing this handler takes over the
   * outside-files branch; returning true means the drop was handled (no
   * explanation). It is intentionally absent in D4 so only the explanation shows,
   * but the branch structure here does not change when W5 plugs in.
   */
  onCopyIntoLibrary?: (paths: string[], outsideCount: number) => boolean
}

/**
 * Routes one OS file drop (plan 3 §6 drag-in):
 * - unmapped library → explain how to locate it;
 * - files inside the mapped root → reverse-map to relative paths → fast-add;
 * - files outside every root → the W5 copy-in seam, else the explanation.
 */
export async function handleFileDrop(paths: string[], routing: FileDropRouting): Promise<void> {
  if (paths.length === 0) return
  if (!routing.libraryMapped) {
    routing.onFlash(DROP_UNMAPPED_MESSAGE)
    return
  }

  let result: ReverseMapResult
  try {
    result = await routing.reverseMap(routing.libraryId, paths)
  } catch (error) {
    // e.g. the mount went offline between mapping and drop (volume_not_mounted).
    routing.onFlash(hostOperationErrorMessage(error))
    return
  }

  if (result.inside.length > 0) {
    routing.onFastAdd(result.inside)
    if (result.outsideCount > 0) routing.onFlash(droppedPartialOutsideMessage(result.outsideCount))
    return
  }

  // Every dropped file is outside the library.
  if (routing.onCopyIntoLibrary?.(paths, result.outsideCount)) return
  routing.onFlash(DROP_OUTSIDE_MESSAGE)
}

/**
 * Subscribes to OS file drops onto the shell window and routes each through
 * `handleFileDrop`. No-op in the browser. The latest routing is read through a
 * ref so library/selection changes never re-subscribe (mirrors useDesktopMenu).
 */
export function useDesktopFileDrop(routing: FileDropRouting): void {
  const routingRef = useRef(routing)
  useEffect(() => {
    routingRef.current = routing
  }, [routing])

  useEffect(() => {
    if (!isDesktopHost()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listenHostFileDrop((paths) => {
      void handleFileDrop(paths, routingRef.current)
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch((error: unknown) => console.error('Could not start desktop file-drop handling', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])
}
