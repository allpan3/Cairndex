import { useEffect, useRef } from 'react'

import {
  hostOperationErrorMessage,
  isDesktopHost,
  isHostDragOutActive,
  listenHostFileDrop,
  type ReverseMapResult,
} from '../platform'

// The active library is not located on this computer, so nothing can be inside it.
export const DROP_UNMAPPED_MESSAGE =
  'Locate this library on this computer first (Settings → Libraries) to add files by dragging them in.'

// The mapping is still being resolved (e.g. right after switching libraries); the
// drop is deferred rather than mis-reported as unmapped.
export const DROP_PENDING_MESSAGE =
  'Checking this library’s location — try the drag again in a moment.'

// A modal dialog or the fullscreen viewer is open; a drop is ignored so it never
// silently re-seeds an open Create Bundle dialog or acts behind another surface.
export const DROP_BLOCKED_MESSAGE = 'Close the open dialog before dragging files in.'

// No dropped item could be added: every one is outside the library or is a folder.
// Cairndex links files in place, so they must be moved in first (or, once plan 4
// W5 lands, copied in — see onCopyIntoLibrary below).
export const DROP_OUTSIDE_MESSAGE =
  'Cairndex links files already inside this library — move these into its folder first, then drag them in.'

// Some dropped items were bundled and some could not be (outside the library, or a
// folder — folders aren't recursed in this milestone).
export function droppedPartialMessage(skippedCount: number): string {
  const items = skippedCount === 1 ? 'item' : 'items'
  return `${skippedCount} ${items} couldn’t be added — Cairndex links files already inside this library.`
}

/** The active library's local mapping state, so a drop is not mis-reported while
 * the mapping query is still in flight (P1-8). */
export type DropMappingState = 'mapped' | 'unmapped' | 'pending'

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
   * Plan 4 W5 seam. Dropping files from *outside* the library is the owner's
   * driving use case for write mode: W5 will replace the explanation with a
   * "Copy into library…" flow that streams the local files to the server's
   * journaled write path. It is offered the un-addable portion of *every* drop —
   * both an all-outside drop and the outside remainder of a mixed drop (whose
   * in-library media has already been sent to fast-add) — with the full drop
   * `paths` plus the reverse-map `result` for context. Returning true means the
   * seam handled that portion (no explanation shown). It is intentionally absent
   * in D4, so only the explanation shows; the branch structure does not change
   * when W5 plugs in.
   */
  onCopyIntoLibrary?: (paths: string[], result: ReverseMapResult) => boolean
}

/** True while a modal dialog or the fullscreen viewer is open. Every such surface
 * renders `aria-modal="true"`, so this catches them all — including ones owned by
 * a different component (Settings) — without threading their open state here. */
export function isBlockingSurfaceOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[aria-modal="true"]') !== null
}

/**
 * Routes one OS file drop (plan 3 §6 drag-in):
 * - a blocking surface (any modal/viewer) or a still-pending mapping → defer;
 * - unmapped library → explain how to locate it;
 * - files inside the mapped root → reverse-map to relative paths → fast-add;
 * - any un-addable remainder (outside the library, or a folder) → the W5 copy-in
 *   seam, else the explanation.
 *
 * `blocked` is passed explicitly (the hook computes it from the DOM) so a drop
 * never silently re-seeds an open Create Bundle dialog or acts behind one (P0-3).
 */
export async function handleFileDrop(
  paths: string[],
  routing: FileDropRouting,
  blocked = false,
): Promise<void> {
  if (paths.length === 0) return
  if (blocked) {
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

  // Offer the un-addable remainder (outside files / folders) to the W5 seam,
  // whether the drop was all-outside or mixed. Absent in D4 → explain instead.
  if (result.outsideCount > 0) {
    if (routing.onCopyIntoLibrary?.(paths, result)) return
    routing.onFlash(
      result.inside.length > 0 ? droppedPartialMessage(result.outsideCount) : DROP_OUTSIDE_MESSAGE,
    )
  }
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
      // Ignore drops while a modal/viewer is open (P0-3) or while the app's own
      // drag-out is still on the pasteboard (P1-4, self-drop re-entry).
      void handleFileDrop(
        paths,
        routingRef.current,
        isBlockingSurfaceOpen() || isHostDragOutActive(),
      )
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
