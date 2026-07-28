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
    // One capture-phase mousedown does both jobs: close, and stop the gesture
    // there. Stopping only the *click* was not enough — the bundle grid selects
    // and clears on mousedown/mouseup (see useMarqueeSelect), so clicking away
    // to dismiss the picker still wiped the selection, taking the inspector and
    // the picker's own anchor with it (owner, twice: 2026-07-27).
    //
    // Capture, so this runs before React's root listener and before any
    // element-level handler underneath. A dismissing gesture does one thing.
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return
      setOpen(false)
      e.stopPropagation()
    }
    // The click that dismisses the popover has done its job and must not also
    // act on whatever was underneath — clicking away to close the tag picker was
    // clearing the bundle selection, taking the inspector (and the picker's own
    // anchor) with it (owner, 2026-07-27). Captured, so it is stopped before it
    // reaches React's root listener.
    // The click and mouseup that follow that mousedown belong to it too — the
    // marquee finishes its gesture on mouseup, and React's onClick handlers
    // would otherwise still fire.
    const onAway = (e: MouseEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || panelRef.current?.contains(t)) return
      e.stopPropagation()
    }
    // Escape dismisses the picker, and stops there — the viewer and the shell
    // both close on Escape, and dismissing a picker should not also put away
    // whatever is behind it (owner, 2026-07-27). Captured for the same reason.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      e.stopPropagation()
      e.preventDefault()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onAway, true)
    window.addEventListener('click', onAway, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('resize', reposition)
    // Capture phase so a scroll on the inspector (or any ancestor) repositions.
    window.addEventListener('scroll', reposition, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onAway, true)
      window.removeEventListener('click', onAway, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('resize', reposition)
      window.removeEventListener('scroll', reposition, true)
    }
  }, [open, reposition])

  return { open, setOpen, ref, panelRef, pos }
}

type HierItem = { id: string; parent_id: string | null; name: string }

/** Order hierarchical items (parent_id self-ref) depth-first with a depth. */
export function flattenHierarchy<T extends HierItem>(items: T[]): { item: T; depth: number }[] {
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

/**
 * Depth-first rows for a foldable tree: skips descendants of any collapsed row,
 * and flags whether each row has children (for a fold chevron). A parent that
 * isn't itself in `items` makes its children top-level, so a filtered subset
 * still renders as a sensible forest.
 */
export function visibleHierarchy<T extends HierItem>(
  items: T[],
  collapsed: Set<string>,
): { item: T; depth: number; hasChildren: boolean }[] {
  const ids = new Set(items.map((i) => i.id))
  const byParent = new Map<string | null, T[]>()
  for (const it of items) {
    const key = it.parent_id && ids.has(it.parent_id) ? it.parent_id : null
    byParent.set(key, [...(byParent.get(key) ?? []), it])
  }
  const out: { item: T; depth: number; hasChildren: boolean }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const it of (byParent.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const hasChildren = (byParent.get(it.id) ?? []).length > 0
      out.push({ item: it, depth, hasChildren })
      if (hasChildren && !collapsed.has(it.id)) walk(it.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
