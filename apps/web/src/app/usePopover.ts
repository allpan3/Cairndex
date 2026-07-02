import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Open/close state for a popover that closes on an outside click.
 *
 * The panel is rendered into a portal and positioned `fixed` from the
 * anchor's bounding rect so it escapes any scrolling/clipping ancestor
 * (e.g. the inspector's `overflow: auto`). `pos` is the computed viewport
 * coordinates: top below the anchor, right-aligned to the anchor's right.
 */
interface PopoverPos {
  top?: number
  bottom?: number
  right: number
  maxHeight: number
}

export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PopoverPos | null>(null)

  const reposition = useCallback(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const margin = 8
    const right = window.innerWidth - r.right
    const spaceBelow = window.innerHeight - r.bottom - margin
    const spaceAbove = r.top - margin
    const cap = (h: number) => Math.max(160, Math.min(520, h))
    // Open below when there's room; otherwise flip above the anchor. Either way
    // the panel is capped to the available space so it never runs off-screen.
    if (spaceBelow >= 240 || spaceBelow >= spaceAbove) {
      setPos({ top: r.bottom + 4, right, maxHeight: cap(spaceBelow) })
    } else {
      setPos({ bottom: window.innerHeight - r.top + 4, right, maxHeight: cap(spaceAbove) })
    }
  }, [])

  useEffect(() => {
    if (!open) return
    reposition()
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('resize', reposition)
    // Capture phase so a scroll on the inspector (or any ancestor) repositions.
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  return { open, setOpen, ref, panelRef, pos }
}

/** Order hierarchical items (parent_id self-ref) depth-first with a depth. */
export function flattenHierarchy<T extends { id: string; parent_id: string | null; name: string }>(
  items: T[],
): { item: T; depth: number }[] {
  const byParent = new Map<string | null, T[]>()
  for (const it of items) {
    const key = it.parent_id ?? null
    byParent.set(key, [...(byParent.get(key) ?? []), it])
  }
  const out: { item: T; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const it of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({ item: it, depth })
      walk(it.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
