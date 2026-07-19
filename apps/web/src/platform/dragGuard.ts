import type { DragOutItem } from './index'

// Matches the Rust `DRAG_ENDED_EVENT`; payload is the drag id this guard assigned.
const DRAG_ENDED_EVENT = 'cairndex://drag-out-ended'
// Keep the guard briefly after the ended event so a drop racing in just behind it
// is still recognized as our own drag rather than treated as a fresh Finder drop.
const DRAG_GRACE_MS = 300
// Last resort: if the ended event is ever lost, don't wedge drag-in for the session.
// Generous because a drag can hover for a long time before the user drops.
const DRAG_TIMEOUT_MS = 5 * 60_000

/** Tauri primitives, injected so the guard is unit-testable without the runtime. */
export interface DragGuardDeps {
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>
  listen: (event: string, handler: (event: { payload: number }) => void) => Promise<() => void>
}

export interface DragGuard {
  startFileDrag: (items: DragOutItem[]) => Promise<void>
  isActive: () => boolean
  release: () => void
}

/**
 * Guards against a shell drag-out being re-imported when its own files are dropped
 * back onto the window (plan 3 §6, D4 review P0-4). Each drag is tagged with a
 * monotonic id passed to Rust, which echoes it in the drag-ended event; the guard
 * clears only for the current drag's id, so a stale ended event from an earlier
 * drag can't clear a later one. `listen` (not `once`) with explicit unlisten keeps
 * orphaned listeners from stacking. A short grace after the ended event and a
 * last-resort timeout make the guard robust to a racing drop and a lost event.
 */
export function createDragGuard(deps: DragGuardDeps): DragGuard {
  let nextId = 0
  let activeId: number | null = null
  let unlisten: (() => void) | undefined
  let graceTimer: ReturnType<typeof setTimeout> | undefined
  let hardTimer: ReturnType<typeof setTimeout> | undefined

  const clearTimers = () => {
    if (graceTimer !== undefined) clearTimeout(graceTimer)
    if (hardTimer !== undefined) clearTimeout(hardTimer)
    graceTimer = undefined
    hardTimer = undefined
  }

  const release = () => {
    activeId = null
    clearTimers()
    unlisten?.()
    unlisten = undefined
  }

  const startFileDrag = async (items: DragOutItem[]): Promise<void> => {
    const dragId = ++nextId
    release() // only one native drag at a time; drop any prior guard
    activeId = dragId
    hardTimer = setTimeout(() => {
      if (activeId === dragId) {
        console.warn('Drag-out guard timed out without a drag-ended event; releasing.')
        release()
      }
    }, DRAG_TIMEOUT_MS)
    try {
      const stop = await deps.listen(DRAG_ENDED_EVENT, (event) => {
        if (event.payload !== dragId) return // stale event from an earlier drag
        clearTimers()
        graceTimer = setTimeout(() => {
          if (activeId === dragId) release()
        }, DRAG_GRACE_MS)
      })
      // Released while the listener was registering (fast belt release): drop it.
      if (activeId === dragId) unlisten = stop
      else stop()
      await deps.invoke('start_file_drag', { items, dragId })
    } catch (error) {
      // The drag never started (or the listener failed to register), so its end
      // event will never fire: release now so drag-in is not wedged.
      if (activeId === dragId) release()
      throw error
    }
  }

  return { startFileDrag, isActive: () => activeId !== null, release }
}
