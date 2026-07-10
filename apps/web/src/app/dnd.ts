// Shared drag-and-drop model for the Bundle Browser. A drag can carry either a
// set of bundles or a single collection; drop targets (folder cards, sidebar
// rows) react based on the payload. Kept in App-level state (same-document drag),
// so components don't need to (de)serialize dataTransfer during dragover.

export type DragItem = { kind: 'bundles'; ids: string[] } | { kind: 'collection'; id: string }

// Where a drop will land relative to the hovered item: reorder before/after it,
// or move *into* it (reparent a collection / add a bundle).
export type DropZone = 'before' | 'into' | 'after'

/** Classify the cursor position over a target into before / into / after. The
 * middle band is "into"; the leading/trailing bands reorder. `orientation` is
 * 'horizontal' for grid tiles (left/right) and 'vertical' for list rows
 * (top/bottom). When `allowInto` is false (e.g. a bundle grid where you can only
 * reorder), it collapses to a before/after split at the midpoint. */
export function dropZone(
  e: { clientX: number; clientY: number },
  rect: DOMRect,
  orientation: 'horizontal' | 'vertical',
  allowInto: boolean,
): DropZone {
  const frac =
    orientation === 'horizontal'
      ? (e.clientX - rect.left) / rect.width
      : (e.clientY - rect.top) / rect.height
  if (!allowInto) return frac < 0.5 ? 'before' : 'after'
  if (frac < 0.28) return 'before'
  if (frac > 0.72) return 'after'
  return 'into'
}
