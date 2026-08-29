/**
 * Where a scrollbar thumb sits, given a scroller's geometry.
 *
 * Its own module rather than living beside the component: pure, and jsdom has
 * no scroll geometry, so this arithmetic is the only part of an overlay
 * scrollbar a unit test can actually reach.
 */
export function thumbGeometry(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  minimum = 28,
): { height: number; offset: number } | null {
  const overflow = scrollHeight - clientHeight
  // A sub-pixel overflow is rounding, not content: drawing a thumb for it makes
  // a bar flicker into view on panels that actually fit.
  if (overflow < 1 || clientHeight <= 0) return null
  const height = Math.min(
    clientHeight,
    Math.max(minimum, (clientHeight / scrollHeight) * clientHeight),
  )
  const travel = clientHeight - height
  const progress = Math.min(1, Math.max(0, scrollTop / overflow))
  return { height, offset: progress * travel }
}

/** Where to scroll to when the thumb is dragged to `pointerY`. */
export function scrollTopForDrag(
  pointerY: number,
  panelTop: number,
  panelHeight: number,
  thumbHeight: number,
  scrollHeight: number,
): number {
  const travel = panelHeight - thumbHeight
  if (travel <= 0) return 0
  // Grabs the thumb by its middle, so it does not jump under the pointer.
  const progress = (pointerY - panelTop - thumbHeight / 2) / travel
  return Math.min(1, Math.max(0, progress)) * (scrollHeight - panelHeight)
}
