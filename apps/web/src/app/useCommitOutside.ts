import { useEffect, useRef, type RefObject } from 'react'

/**
 * Commits an inline editor when the pointer goes down anywhere outside it.
 *
 * A blur handler alone is not enough. The listing's marquee/drag handling calls
 * `preventDefault` on a mousedown over a draggable row, which is what keeps a
 * press-drag from starting a text selection — but it also stops focus, and so
 * the blur, from ever moving. Clicking a file while renaming therefore left the
 * editor open with the new name uncommitted (owner, 2026-09-01). Capture phase,
 * so the name is committed before the click that lands underneath changes the
 * selection out from under it.
 */
export function useCommitOnPointerDownOutside(
  active: boolean,
  element: RefObject<HTMLElement | null>,
  commit: () => void,
): void {
  const commitRef = useRef(commit)
  useEffect(() => {
    commitRef.current = commit
  })

  useEffect(() => {
    if (!active) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && element.current?.contains(target)) return
      commitRef.current()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [active, element])
}
