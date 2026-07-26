/**
 * One compact, consistent drag preview for every internal drag.
 *
 * Left to itself the browser snapshots the drag *source element*, which gave a
 * different ghost per surface: a grid card produced a large half-transparent
 * image that hid the drop target underneath, a list row produced a full-width
 * one-line sliver, and some nodes produced nothing at all (WebKit declines to
 * snapshot certain composited elements). Substituting a small labelled pill
 * makes every drag look the same and keeps the view under the cursor readable.
 *
 * The node must be attached and rendered when `setDragImage` is called — the
 * snapshot is taken synchronously — and WebKit captures blank for off-screen
 * elements, so `.drag-badge` sits at the window origin *behind* the opaque app
 * surface (z-index: -1) instead of at negative coordinates. It is removed on
 * the next tick, after the engine has taken its picture.
 */
export function setDragBadge(e: React.DragEvent, label: string): void {
  if (typeof e.dataTransfer.setDragImage !== 'function') return // jsdom
  // A transparent lead-in shifts the visible pill to the right of the cursor —
  // negative setDragImage offsets are clamped by WebKit, so the offset is baked
  // into the image itself instead.
  const node = document.createElement('div')
  node.className = 'drag-badge'
  const pill = document.createElement('div')
  pill.className = 'drag-badge__pill'
  pill.textContent = label
  node.appendChild(pill)
  document.body.appendChild(node)
  e.dataTransfer.setDragImage(node, 0, 14)
  setTimeout(() => node.remove(), 0)
}

/** The badge label for a multi-item drag: the count, or the one item's name. */
export function dragBadgeLabel(count: number, single: string, noun: string): string {
  return count > 1 ? `${count} ${noun}s` : single
}
