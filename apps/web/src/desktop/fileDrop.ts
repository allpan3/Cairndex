import { useEffect, useRef } from 'react'

import {
  hostOperationErrorMessage,
  isDesktopHost,
  isHostDragOutActive,
  listenHostFileDrop,
  releaseHostDragOut,
  type ReverseMapResult,
} from '../platform'

// The active library is not located on this computer, so nothing can be inside it.
export const DROP_UNMAPPED_MESSAGE =
  'Locate this library on this computer first (Settings → Libraries) to add files by dragging them in.'

// The mapping is still being resolved (e.g. right after switching libraries); the
// drop is deferred rather than mis-reported as unmapped.
export const DROP_PENDING_MESSAGE =
  'Checking this library’s location — try the drag again in a moment.'

// A modal dialog, context menu, or the fullscreen viewer is open; a drop is ignored
// so it never silently re-seeds an open Create Bundle dialog or acts behind another
// surface.
export const DROP_BLOCKED_MESSAGE = 'Close the open dialog before dragging files in.'

// Every dropped file is outside the library, and this library cannot be written
// to — so copying them in is not available and linking in place is not possible.
// With write mode on, `onCopyIntoLibrary` handles these and this never shows.
export const DROP_OUTSIDE_MESSAGE =
  'Cairndex links files already inside this library — move these into its folder first, or turn on write mode for it to copy files in.'

// A dropped folder — folders aren't recursed in this milestone, so the files inside
// must be dragged in directly.
export const DROP_DIRECTORY_MESSAGE =
  "Folders can't be dragged in yet — drop the files inside them."

// Some dropped files were bundled and some were left outside the library.
export function droppedPartialMessage(outsideCount: number): string {
  const items = outsideCount === 1 ? 'item' : 'items'
  return `${outsideCount} ${items} couldn’t be added — Cairndex links files already inside this library.`
}

/** The active library's local mapping state, so a drop is not mis-reported while
 * the mapping query is still in flight (P1-8). */
export type DropMappingState = 'mapped' | 'unmapped' | 'pending'

/** Why a drop is being ignored: a modal/menu/viewer is open (explain), or the app's
 * own drag-out is still in flight and landed back on us (ignore silently). Null when
 * the drop should be processed. */
export type DropBlockReason = 'modal' | 'self-drag' | null

/** Everything the drop router needs; injected so the routing is unit-testable. */
export interface FileDropRouting {
  libraryId: string
  mappingState: DropMappingState
  reverseMap: (libraryId: string, paths: string[]) => Promise<ReverseMapResult>
  // Hand the in-library relative paths to the existing fast-add / manual-bundling
  // flow (opens Create Bundle seeded with these files).
  onFastAdd: (relativePaths: string[]) => void
  onFlash: (message: string) => void
  /**
   * The copy-in flow (plan 4 W5). Dropping files from *outside* the library is
   * the owner's driving use case for write mode: the shell streams each local
   * file to the server's journaled import endpoint. Supplied only when the
   * library actually permits writing — otherwise the explanation below is still
   * the true answer. It is handed **exactly the outside absolute paths**
   * (`result.outside`) — the un-addable file portion of every drop, whether the
   * drop was all-outside or the outside remainder of a mixed drop whose in-library
   * media already went to fast-add — plus the full reverse-map `result` for
   * context. Returning true means the seam handled those files (no explanation for
   * them). Dropped folders are never offered to the seam (they can't be copied
   * without recursion). Absent in a browser and for a read-only library, where
   * only the explanation shows.
   */
  onCopyIntoLibrary?: (outsidePaths: string[], result: ReverseMapResult) => boolean
}

/** True while a modal dialog, the fullscreen viewer, a context menu, or a toolbar
 * popover is open — so a drop is not routed behind it (P0-3, P1-6). Modals/viewers
 * carry `aria-modal="true"` and the context menu `role="menu"`; popover panels have
 * no semantic role, so their shared `.picker__panel` class is used. */
export function isBlockingSurfaceOpen(): boolean {
  return (
    typeof document !== 'undefined' &&
    document.querySelector('[aria-modal="true"], [role="menu"], .picker__panel') !== null
  )
}

/**
 * Routes one OS file drop (plan 3 §6 drag-in):
 * - `blockReason` set → deferred: 'modal' explains, 'self-drag' is a silent ignore;
 * - a still-pending mapping → defer; unmapped library → explain how to locate it;
 * - regular files inside the mapped root → reverse-map → fast-add;
 * - regular files outside it → the W5 copy-in seam, else the explanation;
 * - dropped folders → their own "drop the files inside" message.
 *
 * `blockReason` is passed explicitly (the hook computes it) so a drop never
 * silently re-seeds an open dialog (P0-3) nor re-imports the app's own drag (P0-4).
 */
export async function handleFileDrop(
  paths: string[],
  routing: FileDropRouting,
  blockReason: DropBlockReason = null,
): Promise<void> {
  if (paths.length === 0) return
  if (blockReason === 'self-drag') return // our own drag landed back on us: ignore
  if (blockReason === 'modal') {
    routing.onFlash(DROP_BLOCKED_MESSAGE)
    return
  }
  if (routing.mappingState === 'pending') {
    routing.onFlash(DROP_PENDING_MESSAGE)
    return
  }
  if (routing.mappingState === 'unmapped') {
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

  // In-library media seeds the fast-add flow (Create Bundle); the server tolerates
  // and reports any non-media file in that batch.
  if (result.inside.length > 0) routing.onFastAdd(result.inside)

  // Offer the outside *files* to the W5 seam (all-outside or the remainder of a
  // mixed drop). Folders can't be copied, so they never reach the seam.
  const handledOutside =
    result.outside.length > 0
      ? (routing.onCopyIntoLibrary?.(result.outside, result) ?? false)
      : false

  const notes: string[] = []
  if (result.outside.length > 0 && !handledOutside) {
    notes.push(
      result.inside.length > 0
        ? droppedPartialMessage(result.outside.length)
        : DROP_OUTSIDE_MESSAGE,
    )
  }
  if (result.directories > 0) notes.push(DROP_DIRECTORY_MESSAGE)
  if (notes.length > 0) routing.onFlash(notes.join(' '))
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
      let reason: DropBlockReason = null
      if (isHostDragOutActive()) {
        // The app's own drag-out landed back on us: ignore this drop, and release
        // the guard now since a drop means the native session ended (P0-4 belt).
        reason = 'self-drag'
        releaseHostDragOut()
      } else if (isBlockingSurfaceOpen()) {
        reason = 'modal'
      }
      void handleFileDrop(paths, routingRef.current, reason)
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
