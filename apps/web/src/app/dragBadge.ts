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
  showDragImage(e, badgeNode(label))
}

// At most three covers stack in a bundle drag, as in Eagle
const STACK = 3
// The longest side of a cover in the stack, and each cover's offset behind the one before
const SIDE = 96
const STEP = 6

/**
 * The drag preview for bundles: the covers of up to three dragged cards,
 * stacked with the grabbed card in front, above the same label as the pill.
 * Only covers already on screen and decoded take part, drawn onto canvases at
 * once, because the engine takes its snapshot synchronously and a fresh `<img>`
 * may not have decoded by then. With no such cover it is the plain pill.
 */
export function setCoversDragImage(
  e: React.DragEvent,
  label: string,
  covers: HTMLImageElement[],
): void {
  if (typeof e.dataTransfer.setDragImage !== 'function') return // jsdom
  const shown = covers.filter((cover) => cover.complete && cover.naturalWidth > 0).slice(0, STACK)
  if (!shown.length) {
    showDragImage(e, badgeNode(label))
    return
  }
  const node = badgeNode(label)
  node.classList.add('drag-badge--covers')
  const stack = document.createElement('div')
  stack.className = 'drag-badge__stack'
  const ratio = window.devicePixelRatio || 1
  let width = 0
  let height = 0
  // Back to front, so the grabbed card's cover, first in `shown`, is drawn last
  for (let depth = shown.length - 1; depth >= 0; depth--) {
    const cover = shown[depth]!
    const scale = SIDE / Math.max(cover.naturalWidth, cover.naturalHeight)
    const w = Math.max(1, Math.round(cover.naturalWidth * scale))
    const h = Math.max(1, Math.round(cover.naturalHeight * scale))
    const canvas = document.createElement('canvas')
    canvas.className = 'drag-badge__cover'
    canvas.width = Math.round(w * ratio)
    canvas.height = Math.round(h * ratio)
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    canvas.style.left = `${depth * STEP}px`
    canvas.style.top = `${depth * STEP}px`
    canvas.getContext('2d')?.drawImage(cover, 0, 0, canvas.width, canvas.height)
    stack.appendChild(canvas)
    width = Math.max(width, w + depth * STEP)
    height = Math.max(height, h + depth * STEP)
  }
  stack.style.width = `${width}px`
  stack.style.height = `${height}px`
  node.prepend(stack)
  showDragImage(e, node)
}

/**
 * Decoded covers of the dragged bundles that are on screen under `root`, the
 * grabbed one first, at most three: what a bundle drag preview can show.
 */
export function draggedCovers(
  root: HTMLElement | null,
  grabbed: string,
  ids: string[],
): HTMLImageElement[] {
  if (!root) return []
  const rendered = new Map<string, HTMLImageElement>()
  for (const cover of root.querySelectorAll<HTMLImageElement>('[data-bundle-id] img.cover-image')) {
    const id = cover.closest<HTMLElement>('[data-bundle-id]')?.dataset.bundleId
    if (id && cover.complete && cover.naturalWidth > 0) rendered.set(id, cover)
  }
  const covers: HTMLImageElement[] = []
  for (const id of [grabbed, ...ids.filter((id) => id !== grabbed)]) {
    const cover = rendered.get(id)
    if (cover) covers.push(cover)
    if (covers.length === STACK) break
  }
  return covers
}

// A transparent lead-in shifts the visible pill to the right of the cursor —
// negative setDragImage offsets are clamped by WebKit, so the offset is baked
// into the image itself instead.
function badgeNode(label: string): HTMLDivElement {
  const node = document.createElement('div')
  node.className = 'drag-badge'
  const pill = document.createElement('div')
  pill.className = 'drag-badge__pill'
  pill.textContent = label
  node.appendChild(pill)
  return node
}

function showDragImage(e: React.DragEvent, node: HTMLElement): void {
  document.body.appendChild(node)
  e.dataTransfer.setDragImage(node, 0, 14)
  setTimeout(() => node.remove(), 0)
}

/** The badge label for a multi-item drag: the count, or the one item's name. */
export function dragBadgeLabel(count: number, single: string, noun: string): string {
  return count > 1 ? `${count} ${noun}s` : single
}
