import type { CSSProperties } from 'react'

/** Style for a range input whose track fills up to `value` (see index.css). */
export function rangeFill(value: number, min: number, max: number): CSSProperties {
  const share = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0
  return { '--range-fill': `${share * 100}%` } as CSSProperties
}
