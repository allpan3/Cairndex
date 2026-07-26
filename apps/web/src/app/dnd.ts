// Shared drag-and-drop model for the Bundle Browser. A drag can carry either a
// set of bundles or a single collection; drop targets (folder cards, sidebar
// rows) react based on the payload. Kept in App-level state (same-document drag),
// so components don't need to (de)serialize dataTransfer during dragover.

// A collection drag carries the whole selected set in `ids` (multi-select drags
// like a bundle drag does) plus `id`, the one row/card actually grabbed. The
// grabbed one is what reorder math anchors on — "drop these three after the card
// I'm holding" needs to know which of the three is under the cursor — while
// `ids` is what actually moves. For a plain unselected drag both agree: [id].
export type DragItem =
  | { kind: 'bundles'; ids: string[] }
  | { kind: 'collection'; id: string; ids: string[] }

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

/** DataTransfer type carrying the dragged bundle ids (space-separated).
 *
 * The payload travels with the drag rather than in React state, so a drop never
 * depends on a render having happened since `dragstart` — the source of drops
 * that landed in the wrong place, or did nothing at all. */
export const DRAG_BUNDLES = 'application/x-cairndex-bundles'
