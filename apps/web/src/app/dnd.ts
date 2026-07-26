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
  const size = orientation === 'horizontal' ? rect.width : rect.height
  const frac =
    orientation === 'horizontal' ? (e.clientX - rect.left) / size : (e.clientY - rect.top) / size
  if (!allowInto) return frac < 0.5 ? 'before' : 'after'
  // 28% of a 226px card is a comfortable 63px, but 28% of a 28px sidebar row is
  // 8px — a band you have to aim for, which is why nesting kept winning drags
  // meant as reorders there. The reorder edges get a floor of 10px so short rows
  // stay usable, while the middle keeps at least a third of the row for nesting.
  const edge = Math.min(Math.max(0.28 * size, 10), size / 3) / size
  if (frac < edge) return 'before'
  if (frac > 1 - edge) return 'after'
  return 'into'
}

/** DataTransfer type carrying the dragged bundle ids (space-separated).
 *
 * The payload travels with the drag rather than in React state, so a drop never
 * depends on a render having happened since `dragstart` — the source of drops
 * that landed in the wrong place, or did nothing at all. */
export const DRAG_BUNDLES = 'application/x-cairndex-bundles'

// The drag payload, synchronously. React's `dragItem` state is the *reactive*
// copy — right for painting highlights, wrong for commit paths: a fast drag can
// deliver its drop before React has committed the dragstart's state update, and
// a handler gating on the prop then does nothing (a drag the owner made,
// silently discarded). Every dragstart/dragend writes here as well; dragover
// and drop handlers read here. Same-window only, which is all internal
// drag-and-drop ever is.
let activeDrag: DragItem | null = null

export function setActiveDrag(item: DragItem | null): void {
  activeDrag = item
}

export function getActiveDrag(): DragItem | null {
  return activeDrag
}

/**
 * Where a reorder drop will land, named once.
 *
 * A gap between two cards can be described from either side — "after the left
 * one" or "before the right one" — and describing it both ways made a single
 * insertion point look like two seams that did the same thing. So a drop
 * resolves to a destination: the item the moved block lands in front of, or
 * `null` for the end of the group. `into` is the separate gesture of nesting.
 */
export type DropTarget = { kind: 'into'; id: string } | { kind: 'gap'; beforeId: string | null }

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind !== b.kind) return false
  return a.kind === 'into' && b.kind === 'into'
    ? a.id === b.id
    : a.kind === 'gap' && b.kind === 'gap' && a.beforeId === b.beforeId
}

/**
 * The seam this item should paint for a destination, if any — a leading line on
 * the item the block lands before, or a trailing line on the last item when the
 * block lands at the end. Exactly one item in a group ever answers non-undefined,
 * which is the whole point.
 */
export function seamFor(
  target: DropTarget | null,
  id: string,
  order: string[],
): 'before' | 'after' | undefined {
  if (target === null || target.kind !== 'gap') return undefined
  if (target.beforeId !== null) return target.beforeId === id ? 'before' : undefined
  return order[order.length - 1] === id ? 'after' : undefined
}

/**
 * A drop destination inside the collection *tree*.
 *
 * Same idea as DropTarget, with the parent group attached: on screen a tree
 * interleaves rows from several levels, so "the end of the group" is meaningless
 * without saying which group. `beforeId` still names the row the moved block
 * lands in front of.
 */
export type TreeDrop =
  | { kind: 'into'; id: string }
  | { kind: 'gap'; parentId: string | null; beforeId: string | null }

export function sameTreeDrop(a: TreeDrop | null, b: TreeDrop | null): boolean {
  if (a === null || b === null) return a === b
  if (a.kind === 'into' && b.kind === 'into') return a.id === b.id
  if (a.kind === 'gap' && b.kind === 'gap')
    return a.parentId === b.parentId && a.beforeId === b.beforeId
  return false
}
