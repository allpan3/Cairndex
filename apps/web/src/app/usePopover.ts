import { useEffect, useRef, useState } from 'react'

/** Open/close state for a popover that closes on an outside click. */
export function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return { open, setOpen, ref }
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
