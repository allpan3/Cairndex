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
    // The dismissing gesture belongs to the menu and stops there, the same rule
    // the pickers follow: clicking the sidebar left the menu open, and clicking
    // the shell cleared the bundle selection underneath it — the marquee acts on
    // mousedown/mouseup, so stopping the click alone is too late (owner,
    // 2026-07-27). Captured, so nothing beneath ever sees it.
    const inside = (target: EventTarget | null) => ref.current?.contains(target as Node) ?? false
    const onDown = (e: MouseEvent) => {
      if (inside(e.target)) return
      onClose()
      e.stopPropagation()
      // Own the *rest* of this gesture too. `onClose` clears `state`, which tears
      // this effect down, so the `mouseup` and `click` still to come may find no
      // listener left — and whether they do depends on React flushing the state
      // update before the engine dispatches them. Chromium usually swallowed the
      // click; WKWebView let it through, so dismissing the viewer's menu also
      // toggled playback (owner report, 2026-08-23). One-shot listeners make it
      // deterministic instead of engine-dependent.
      const swallow = (event: Event) => {
        event.stopPropagation()
        event.stopImmediatePropagation()
      }
      window.addEventListener('mouseup', swallow, true)
      window.addEventListener('click', swallow, true)
      // After the gesture, whatever it turned out to be: a drag that never
      // clicks must not leave these attached.
      setTimeout(() => {
        window.removeEventListener('mouseup', swallow, true)
        window.removeEventListener('click', swallow, true)
      }, 0)
      // ...and own the `dblclick` the *next* press can complete, because the app
      // never saw the first half of it.
      //
      // Swallowing the dismissing click hides it from the app but not from the
      // browser's click counter. So the press after a dismissal arrives as click
      // two of a pair and delivers `dblclick` — and `dblclick` on a bundle card
      // opens the media viewer. To the owner that is one click opening the player
      // (owner-reported, 2026-08-29: "single click on the bundle would enter the
      // video player"). It is also why a control clicked right after a dismissal
      // can look dead: its click is the swallowed one.
      //
      // Disarmed by the next press that starts a *fresh* sequence (`detail <= 1`),
      // which is the browser telling us the pair window has closed. The pair's own
      // second press carries `detail === 2`, so it does not disarm this.
      const swallowPairedDblClick = (event: MouseEvent) => {
        if (event.type === 'mousedown') {
          if (event.detail > 1) return
          disarmPair()
          return
        }
        swallow(event)
        disarmPair()
      }
      const disarmPair = () => {
        window.removeEventListener('mousedown', swallowPairedDblClick, true)
        window.removeEventListener('dblclick', swallowPairedDblClick, true)
      }
      window.addEventListener('mousedown', swallowPairedDblClick, true)
      window.addEventListener('dblclick', swallowPairedDblClick, true)
    }
    const onAway = (e: MouseEvent) => {
      if (inside(e.target)) return
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      onClose()
      e.stopPropagation()
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('mouseup', onAway, true)
    window.addEventListener('click', onAway, true)
    window.addEventListener('keydown', onKey, true)
    // Scroll and resize dismiss the menu because it is anchored to a cursor
    // position that stops meaning anything once the page moves under it — but
    // only from the next frame on. The gesture that *opens* a menu can scroll:
    // clicking a `⋯` button near the edge of a scrollable rail focuses it, and
    // the browser brings it into view in the same dispatch. Listening straight
    // away made that button dismiss its own menu (found by the moments e2e,
    // 2026-08-29), and every rail row deep enough to need scrolling had the same
    // fragility.
    let armed = 0
    const arm = () => {
      window.addEventListener('scroll', onClose, true)
      window.addEventListener('resize', onClose)
    }
    armed = requestAnimationFrame(arm)
    return () => {
      cancelAnimationFrame(armed)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onAway, true)
      window.removeEventListener('click', onAway, true)
      window.removeEventListener('keydown', onKey, true)
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
