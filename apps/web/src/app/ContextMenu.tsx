import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { MenuState } from './useContextMenu'

/**
 * A cursor-anchored popup menu rendered into a portal so it escapes any
 * scrolling/clipping ancestor. It closes on an outside click, Escape, scroll,
 * or resize, and flips back on-screen when it would overflow the viewport.
 */
export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  // Place at the cursor, then nudge back inside the viewport once measured.
  const reposition = useCallback(() => {
    if (!state) return
    const el = ref.current
    const w = el?.offsetWidth ?? 200
    const h = el?.offsetHeight ?? 0
    const left = Math.min(state.x, window.innerWidth - w - 8)
    const top = Math.min(state.y, window.innerHeight - h - 8)
    setPos({ left: Math.max(8, left), top: Math.max(8, top) })
  }, [state])

  useLayoutEffect(reposition, [reposition])

  useEffect(() => {
    if (!state) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('resize', onClose)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('resize', onClose)
    }
  }, [state, onClose])

  if (!state) return null

  return createPortal(
    <div
      className="context-menu"
      ref={ref}
      role="menu"
      // Hidden until measured so it never flashes off-screen at the cursor.
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      {state.items.map((item, i) =>
        item === null ? (
          <div key={`sep-${i}`} className="context-menu__sep" role="separator" />
        ) : (
          <button
            key={item.label}
            className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  )
}
