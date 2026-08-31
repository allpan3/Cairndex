import { useSyncExternalStore } from 'react'

/**
 * The moment the last capture created, so its row can open straight into its
 * comment box (plan 7; owner, 2026-08-29).
 *
 * A tiny module store rather than a prop or a context value, because the two
 * ends are in different trees: `ViewerShell` performs the capture, and the
 * Moments section that grows the new row is inside the `Inspector` it docks —
 * which is rendered from a context deliberately kept to *actions*, not
 * transient state. The alternative was threading one id through the inspector's
 * whole prop surface for a fact that lives for one render.
 *
 * Read once, when the new row mounts: a row uses this as the initial value of
 * "is the comment box open", so nothing here can reopen an editor the owner has
 * since dismissed. The row clears it on the way in all the same, so returning to
 * a bundle later does not find a stale flag waiting.
 */
let captured: { bundleId: string; momentId: string } | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Record the moment a capture just created. */
export function noteCapturedMoment(bundleId: string, momentId: string): void {
  captured = { bundleId, momentId }
  emit()
}

/** Forget a capture once its row has opened, so it cannot fire twice. */
export function clearCapturedMoment(momentId: string): void {
  if (captured?.momentId !== momentId) return
  captured = null
  emit()
}

/** The id this bundle just captured, or null. */
export function useJustSavedMoment(bundleId: string): string | null {
  const snapshot = useSyncExternalStore(
    subscribe,
    () => captured,
    () => null,
  )
  return snapshot?.bundleId === bundleId ? snapshot.momentId : null
}
