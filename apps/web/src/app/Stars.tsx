import { useRef, useState } from 'react'

import { RATING_STEP, formatRating, ratingKey, valueFromPointerX } from './rating'

const STAR_POSITIONS = [1, 2, 3, 4, 5]

/** Pointer plumbing shared by the star rows — sweeping only.
 *
 * Two behaviours the half buttons alone cannot give: a hover preview from
 * anywhere over the row (the gaps between stars included), and press-and-drag to
 * sweep to a rating, committing on release.
 *
 * **Picking does not come through here.** Each half is a real `<button>` and a
 * plain click is left to its own `onClick`, which is the portable path.
 *
 * The load-bearing detail is *when* pointer capture is taken. Capture retargets
 * every later event of the gesture to the capturing element — the release **and
 * the click**. Taking it on `pointerdown` therefore means the half button's
 * `onClick` can never fire, so picking has to be reconstructed from the release
 * and the click swallowed. That is what this used to do, and a click on a star
 * did nothing at all in the desktop shell (owner-reported, 2026-07-30).
 *
 * So capture is taken on the first move that changes value — the moment the
 * gesture becomes a sweep, which is the only thing that needs it (it keeps the
 * sweep reporting after the pointer leaves the row). A press-and-release in place
 * never captures, so its click reaches the button untouched. `commitSweep` fires
 * only for a sweep, and only then is the trailing click swallowed — without which
 * a sweep ending on a half button would fire that button too, and in the editor a
 * same-value click *clears*, silently undoing the sweep.
 */
function useStarPointer(commitSweep: (value: number) => void) {
  const rowRef = useRef<HTMLElement | null>(null)
  const [hover, setHover] = useState(0)
  const gesture = useRef<{ start: number; moved: boolean } | null>(null)
  const suppressClick = useRef(false)

  const valueAt = (clientX: number) =>
    rowRef.current ? valueFromPointerX(rowRef.current.querySelectorAll('.star__glyph'), clientX) : 0

  const rowProps = {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.button !== 0) return
      const value = valueAt(event.clientX)
      gesture.current = { start: value, moved: false }
      setHover(value)
      // Any pending suppression belongs to a gesture that is over. A sweep sets
      // the flag expecting a trailing click to consume it, but one does not always
      // arrive — a sweep released outside the row dispatches no click at all — and
      // a flag left set silently swallows the *next* pick.
      suppressClick.current = false
      // Deliberately no setPointerCapture here — see the note above: it would
      // retarget this gesture's click to the row and the half button would never
      // see it. Capture is taken in onPointerMove, once this is a sweep.
    },
    onPointerMove: (event: React.PointerEvent) => {
      const value = valueAt(event.clientX)
      const active = gesture.current
      if (active && value !== active.start && !active.moved) {
        active.moved = true
        // Now it is a sweep, so capture: it keeps reporting to the row after the
        // pointer leaves it. Wrapped rather than optional-called — jsdom has no
        // pointer capture at all, and a rejected call must not break the sweep.
        try {
          ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
        } catch {
          // The sweep stops tracking past the row's edge; nothing else breaks.
        }
      }
      setHover(value)
    },
    onPointerUp: (event: React.PointerEvent) => {
      if (!gesture.current) return
      const { moved } = gesture.current
      gesture.current = null
      // A press-and-release in place is a click: leave it to the half's own
      // button, and leave the click alone so it can get there.
      if (!moved) return
      suppressClick.current = true
      commitSweep(valueAt(event.clientX))
    },
    // Deliberately pointerleave and NOT mouseleave: pointer capture retargets
    // pointer events to the row for the whole gesture, but the compatibility
    // mouseleave still fires the moment a drag crosses the row edge — a
    // mouseleave handler would blank the preview mid-sweep.
    onPointerLeave: () => {
      if (!gesture.current) setHover(0)
    },
    onClickCapture: (event: React.MouseEvent) => {
      if (!suppressClick.current) return
      suppressClick.current = false
      event.preventDefault()
      event.stopPropagation()
    },
  }

  return { rowRef, hover, setHover, rowProps }
}

/**
 * One star, rendered as two independently clickable halves.
 *
 * The fill is a second ★ clipped to 0/50/100% over a muted ★ underneath, rather
 * than a distinct "half star" character: the two layers are the *same glyph*, so
 * the clip lands exactly on the star's midpoint in any font. Swapping the base
 * for ☆ would depend on the outline and solid forms sharing an advance width,
 * which is not guaranteed.
 *
 * The halves stay real buttons for the keyboard and screen readers (ten radios
 * per row); pointer interaction is handled at the row level by `useStarPointer`.
 */
function Star({
  position,
  filledTo,
  onPick,
  onHover,
  selected,
  children,
}: {
  position: number
  /** Rating the row currently displays (hover preview, else the value). */
  filledTo: number
  onPick: (value: number) => void
  onHover: (value: number) => void
  /** The committed value, so only it is the checked radio. */
  selected: number
  /** Optional caption under the star (the facet count). */
  children?: React.ReactNode
}) {
  const half = position - RATING_STEP
  const fillPercent = filledTo >= position ? 100 : filledTo >= half ? 50 : 0

  return (
    <span className="star">
      <span className="star__glyph">
        <span className="star__glyph-base" aria-hidden="true">
          ★
        </span>
        <span className="star__glyph-fill" style={{ width: `${fillPercent}%` }} aria-hidden="true">
          ★
        </span>
        {[half, position].map((value) => (
          <button
            key={value}
            type="button"
            className={`star__half star__half--${value === half ? 'left' : 'right'}`}
            onClick={() => onPick(value)}
            onMouseEnter={() => onHover(value)}
            onFocus={() => onHover(value)}
            role="radio"
            aria-checked={value === selected}
            aria-label={formatRating(value)}
          />
        ))}
      </span>
      {children}
    </span>
  )
}

/** A row of five half-clickable stars. Hovering (or sweeping with the pointer
 * down) previews the fill and names the value in a small hint; releasing picks
 * it. Used by the toolbar Rating filter and the Smart Collection editor's
 * rating row. */
export function StarRow({
  value,
  onPick,
  onSet,
  counts,
  ariaLabel = 'Rating',
}: {
  value: number
  /** Click path — the parent may give a repeat pick toggle semantics. */
  onPick: (n: number) => void
  /** Drag path — always a direct set, never a toggle. Defaults to `onPick`. */
  onSet?: (n: number) => void
  // Optional faceted counts keyed "0.5".."5" shown under each star.
  counts?: Record<string, number>
  ariaLabel?: string
}) {
  // Sweeps always set directly; the toggle semantics a repeat pick may carry
  // belong to the click path, which is `onPick` on each half button.
  const { rowRef, hover, setHover, rowProps } = useStarPointer((picked) =>
    (onSet ?? onPick)(picked),
  )
  const filledTo = hover || value

  return (
    <div
      className="stars"
      role="radiogroup"
      aria-label={ariaLabel}
      ref={rowRef as React.RefObject<HTMLDivElement>}
      {...rowProps}
    >
      {STAR_POSITIONS.map((position) => (
        <Star
          key={position}
          position={position}
          filledTo={filledTo}
          selected={value}
          onPick={onPick}
          onHover={setHover}
        >
          {counts && (
            // One count per star rather than ten, and it describes whichever half
            // is under the pointer — so the number always answers "how many would
            // clicking here match?" With nothing hovered it shows the whole-star
            // count, which is what this row showed before half stars existed.
            <span className="star__count">
              {counts[ratingKey(hover === position - RATING_STEP ? hover : position)] ?? 0}
            </span>
          )}
        </Star>
      ))}
      {/* Names the previewed value while hovering or sweeping ("3½ stars").
          Width is reserved so the row does not shift as it appears. */}
      <span className="stars__hint" aria-hidden="true">
        {hover ? formatRating(hover) : ''}
      </span>
    </div>
  )
}

/** The inspector's rating editor: same half-star geometry, no facet counts.
 * Clicking the current value clears the rating (reports 0); a drag always sets
 * the value it ends on. */
export function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const pick = (picked: number) => onChange(picked === value ? 0 : picked)
  const { rowRef, hover, setHover, rowProps } = useStarPointer((picked) => {
    // A sweep that ends where the rating already is changes nothing — writing
    // it anyway would bump the bundle version for a no-op. (A *click* on the
    // current value clears it; that is `pick`, on the half buttons.)
    if (picked !== value) onChange(picked)
  })
  const filledTo = hover || value

  return (
    <span
      className="stars stars--edit"
      role="radiogroup"
      aria-label="Rating"
      ref={rowRef as React.RefObject<HTMLSpanElement>}
      {...rowProps}
    >
      {/* Leads the stars so the hint grows into the row's empty middle and the
          stars keep their right-aligned position. */}
      <span className="stars__hint stars__hint--lead" aria-hidden="true">
        {hover ? formatRating(hover) : ''}
      </span>
      {STAR_POSITIONS.map((position) => (
        <Star
          key={position}
          position={position}
          filledTo={filledTo}
          selected={value}
          onPick={pick}
          onHover={setHover}
        />
      ))}
    </span>
  )
}
