import { useCallback, useEffect, useRef } from 'react'

/**
 * A horizontal wheel of values that snaps to whichever one sits under the
 * centre mark.
 *
 * Replaces the segmented rows the export dialogs used to carry (owner,
 * 2026-08-15). A segmented control has to fit every option side by side, so it
 * caps out at three or four; a wheel scrolls, so a size list can be as long as
 * it needs to be without the dialog growing.
 *
 * Selection and scroll position are one thing: dragging the strip changes the
 * value, and changing the value scrolls the strip. The pieces that keep those
 * from fighting are the snap points (at rest, exactly one item is centred, so
 * "nearest to centre" is exact rather than approximate) and `settling`, which
 * ignores the scroll events our own centring causes.
 */

export interface WheelOption<T extends string | number> {
  value: T
  label: string
  /** A word under the label — "native", "default" — when one earns its place. */
  note?: string
}

interface WheelPickerProps<T extends string | number> {
  options: WheelOption<T>[]
  value: T
  onChange: (value: T) => void
  /** Accessible name for the group of choices. */
  label: string
  id?: string
}

/** How long after the last scroll event the strip is treated as at rest. */
const SETTLE_MS = 90

export function WheelPicker<T extends string | number>({
  options,
  value,
  onChange,
  label,
  id,
}: WheelPickerProps<T>) {
  const trackRef = useRef<HTMLDivElement | null>(null)
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([])
  // Set while our own `scrollTo` is in flight, so the scroll it produces is not
  // read back as the user choosing something.
  const settling = useRef<number | null>(null)
  const scrollEnd = useRef<number | null>(null)
  // The first centring must not animate: the dialog opens with a value already
  // chosen, and sliding into place from the left looks like a glitch.
  const mounted = useRef(false)

  const selected = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  )

  const centre = useCallback((index: number, smooth: boolean) => {
    const track = trackRef.current
    const item = itemsRef.current[index]
    // jsdom, and a track that has not been laid out yet, report zeroes for all
    // of this; there is nothing to centre on until it has a width.
    if (!track || !item || track.clientWidth === 0) return
    const target = item.offsetLeft + item.offsetWidth / 2 - track.clientWidth / 2
    if (settling.current !== null) window.clearTimeout(settling.current)
    settling.current = window.setTimeout(() => {
      settling.current = null
    }, 400)
    track.scrollTo?.({ left: target, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  useEffect(() => {
    centre(selected, mounted.current)
    mounted.current = true
  }, [centre, selected])

  /** At rest exactly one item is snapped to the centre; adopt it. */
  const onScroll = () => {
    if (scrollEnd.current !== null) window.clearTimeout(scrollEnd.current)
    scrollEnd.current = window.setTimeout(() => {
      scrollEnd.current = null
      if (settling.current !== null) return
      const track = trackRef.current
      if (!track || track.clientWidth === 0) return
      const middle = track.scrollLeft + track.clientWidth / 2
      let nearest = 0
      let best = Infinity
      itemsRef.current.forEach((item, index) => {
        if (!item) return
        const distance = Math.abs(item.offsetLeft + item.offsetWidth / 2 - middle)
        if (distance < best) {
          best = distance
          nearest = index
        }
      })
      const option = options[nearest]
      if (option && option.value !== value) onChange(option.value)
    }, SETTLE_MS)
  }

  useEffect(
    () => () => {
      if (settling.current !== null) window.clearTimeout(settling.current)
      if (scrollEnd.current !== null) window.clearTimeout(scrollEnd.current)
    },
    [],
  )

  const step = (delta: number) => {
    const next = options[Math.min(options.length - 1, Math.max(0, selected + delta))]
    if (next && next.value !== value) onChange(next.value)
  }

  return (
    <div className="wheel" id={id}>
      <div className="wheel__mark" aria-hidden="true" />
      <div
        ref={trackRef}
        className="wheel__track"
        role="radiogroup"
        aria-label={label}
        onScroll={onScroll}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') step(-1)
          else if (event.key === 'ArrowRight') step(1)
          else if (event.key === 'Home') step(-options.length)
          else if (event.key === 'End') step(options.length)
          else return
          event.preventDefault()
        }}
      >
        {options.map((option, index) => {
          const active = index === selected
          return (
            <button
              key={option.value}
              ref={(element) => {
                itemsRef.current[index] = element
              }}
              type="button"
              role="radio"
              aria-checked={active}
              // Spelled out rather than left to concatenation: the label and
              // the note are adjacent spans, so the computed name would run
              // them together as "960pxnative".
              aria-label={option.note ? `${option.label}, ${option.note}` : option.label}
              // Roving focus: one stop for the whole wheel, then arrow keys.
              tabIndex={active ? 0 : -1}
              className={`wheel__item${active ? ' is-active' : ''}`}
              onClick={() => onChange(option.value)}
            >
              <span className="wheel__label">{option.label}</span>
              {option.note && <span className="wheel__note">{option.note}</span>}
            </button>
          )
        })}
      </div>
    </div>
  )
}
