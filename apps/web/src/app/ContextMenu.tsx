import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import type { MenuEntry, MenuState } from './useContextMenu'
import { holdEditBasis } from '../api/editBasis'

/**
 * A cursor-anchored popup menu rendered into a portal so it escapes any
 * scrolling/clipping ancestor. It closes on an outside click, Escape, scroll,
 * or resize, and flips back on-screen when it would overflow the viewport.
 */
export function ContextMenu({ state, onClose }: { state: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => (state ? holdEditBasis(state.editBasis) : undefined), [state])
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
    const inside = (target: EventTarget | null) =>
      target instanceof Node && (ref.current?.contains(target) ?? false)
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
      if (document.activeElement?.closest('[data-submenu]')) return
      state.returnFocus?.focus({ preventScroll: true })
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
    const onScroll = (event: Event) => {
      if (!inside(event.target)) onClose()
    }
    let armed = 0
    const arm = () => {
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', onClose)
    }
    armed = requestAnimationFrame(arm)
    return () => {
      cancelAnimationFrame(armed)
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('mouseup', onAway, true)
      window.removeEventListener('click', onAway, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onClose)
    }
  }, [state, onClose])

  if (!state) return null

  return createPortal(
    <div
      className="context-menu"
      ref={ref}
      // Hidden until measured so it never flashes off-screen at the cursor.
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: 0 }}
    >
      <MenuRows
        key={`${state.x}:${state.y}`}
        items={state.items}
        onActivate={(item) => {
          state.returnFocus?.focus({ preventScroll: true })
          onClose()
          item.onClick?.()
        }}
      />
    </div>,
    document.body,
  )
}

/**
 * A menu that follows its target. The surface's current render rebuilds the
 * entries, so a save that settles while the menu is open enables its actions.
 * The opening snapshot remains when a refresh no longer shows the target.
 *
 * This component, not the surface, rebuilds the entries while rendering. An
 * entry's handler can read a ref or start a write, and the compiler must assume
 * that any call the surface makes while rendering may run it. Building the
 * entries only creates their click handlers, and only those handlers run.
 */
export function TargetContextMenu<T>(props: {
  state: MenuState | null
  target: T | undefined
  entries: (target: T) => MenuEntry[]
  onClose: () => void
}) {
  const { state, target } = props
  return (
    <ContextMenu
      state={state && target !== undefined ? { ...state, items: props.entries(target) } : state}
      onClose={props.onClose}
    />
  )
}

/** Each level owns its focus and its child; closing a child returns to its parent row. */
function MenuRows({
  items,
  onActivate,
  anchor,
  onBack,
  label,
}: {
  items: MenuEntry[]
  onActivate: (item: NonNullable<MenuEntry>) => void
  anchor?: HTMLButtonElement
  onBack?: () => void
  label?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [child, setChild] = useState<{ label: string; anchor: HTMLButtonElement } | null>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>())
  const [pos, setPos] = useState({ left: -9999, top: 0 })
  useLayoutEffect(() => {
    const panel = ref.current
    if (!panel) return
    if (anchor) {
      const rect = anchor.getBoundingClientRect()
      const width = panel.offsetWidth
      setPos({
        left: Math.max(
          8,
          rect.right + width + 8 <= window.innerWidth ? rect.right : rect.left - width,
        ),
        top: Math.max(8, Math.min(rect.top, window.innerHeight - panel.offsetHeight - 8)),
      })
    }
    panel.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })
  }, [anchor])
  const back = () => {
    onBack?.()
    anchor?.focus({ preventScroll: true })
  }
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-submenu={anchor ? '' : undefined}
      className={anchor ? 'context-menu context-menu__submenu' : 'context-menu__rows'}
      style={anchor ? pos : undefined}
      onKeyDown={(event) => {
        event.stopPropagation()
        const enabled = [...buttons.current.values()].filter((button) => !button.disabled)
        const index = enabled.indexOf(document.activeElement as HTMLButtonElement)
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault()
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? enabled.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length
          enabled[next]?.focus({ preventScroll: true })
        } else if (event.key === 'ArrowRight') {
          const item = items.find((item) => item?.label === enabled[index]?.dataset.label)
          if (item?.children && !item.disabled) {
            event.preventDefault()
            setChild({ label: item.label, anchor: enabled[index]! })
          }
        } else if (anchor && ['ArrowLeft', 'Escape'].includes(event.key)) {
          event.preventDefault()
          back()
        } else if (event.key === 'Tab') {
          event.preventDefault()
          enabled[(index + (event.shiftKey ? -1 : 1) + enabled.length) % enabled.length]?.focus()
        }
      }}
    >
      {items.map((item, index) =>
        item === null ? (
          <div key={`sep-${index}`} className="context-menu__sep" role="separator" />
        ) : (
          <div
            key={item.label}
            onMouseEnter={() => {
              if (!item.disabled) {
                const anchor = buttons.current.get(item.label)
                setChild(item.children && anchor ? { label: item.label, anchor } : null)
              }
            }}
          >
            <button
              ref={(element) => {
                if (element) buttons.current.set(item.label, element)
                else buttons.current.delete(item.label)
              }}
              className={`context-menu__item${item.danger ? ' context-menu__item--danger' : ''}`}
              role="menuitem"
              data-label={item.label}
              disabled={item.disabled}
              aria-haspopup={item.children ? 'menu' : undefined}
              aria-expanded={item.children ? child?.label === item.label : undefined}
              onClick={(event) =>
                item.children
                  ? setChild(
                      child?.label === item.label
                        ? null
                        : { label: item.label, anchor: event.currentTarget },
                    )
                  : onActivate(item)
              }
            >
              <span className="context-menu__icon" aria-hidden="true">
                {item.icon}
              </span>
              <span className="context-menu__label">{item.label}</span>
              {item.detail && <span className="context-menu__detail">{item.detail}</span>}
              {item.shortcut && <kbd aria-hidden="true">{item.shortcut}</kbd>}
              {item.children && <span aria-hidden="true">›</span>}
            </button>
            {item.children && child?.label === item.label && (
              <MenuRows
                items={item.children}
                onActivate={onActivate}
                anchor={child.anchor}
                label={item.label}
                onBack={() => setChild(null)}
              />
            )}
          </div>
        ),
      )}
    </div>
  )
}
