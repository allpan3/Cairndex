import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

const HISTORY_LIMIT = 50

/**
 * The Back/Forward pair that leads each surface's top bar, as in v0.2.1. Every
 * change of `current` records the place being left; Back and Forward apply a
 * recorded place without recording themselves. The stacks are refs because
 * only "is each side non-empty" is rendered.
 */
export function useNavigationHistory<T>(
  current: T,
  same: (a: T, b: T) => boolean,
  apply: (destination: T) => void,
): ReactNode {
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])
  const here = useRef(current)
  const applying = useRef(false)
  const [reach, setReach] = useState({ back: false, forward: false })
  const sync = useCallback(
    () => setReach({ back: past.current.length > 0, forward: future.current.length > 0 }),
    [],
  )
  useEffect(() => {
    const previous = here.current
    if (same(previous, current)) return
    here.current = current
    if (applying.current) {
      // This change is a Back/Forward the caller already recorded
      applying.current = false
      return
    }
    past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), previous]
    future.current = []
    sync()
  }, [current, same, sync])
  const go = (from: React.RefObject<T[]>, to: React.RefObject<T[]>) => {
    const destination = from.current.at(-1)
    if (destination === undefined) return
    from.current = from.current.slice(0, -1)
    to.current = [...to.current, here.current]
    applying.current = true
    apply(destination)
    sync()
  }
  return (
    <div className="seg nav-history" role="group" aria-label="Navigation history">
      <button
        onClick={() => go(past, future)}
        disabled={!reach.back}
        aria-label="Back"
        title="Back"
      >
        ‹
      </button>
      <button
        onClick={() => go(future, past)}
        disabled={!reach.forward}
        aria-label="Forward"
        title="Forward"
      >
        ›
      </button>
    </div>
  )
}
