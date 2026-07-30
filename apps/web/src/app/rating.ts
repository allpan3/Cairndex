/** The rating scale, mirroring the server's `domain/rating.py`: 0–5 stars in
 * half-star steps, with `null` meaning unrated. */

export const RATING_STEP = 0.5
export const RATING_MAX = 5

/** Facet-bucket key for a rating value, matching the server's `rating_facet_key`:
 * whole stars key as `"4"`, half stars as `"3.5"`. `String` already does exactly
 * this in JS, so the two sides agree without a shared format string. */
export const ratingKey = (value: number): string => String(value)

/** Compact star count for chips and badges: `3`, `3½`, `½`. */
export function formatRatingCompact(value: number): string {
  const whole = Math.floor(value)
  if (!(value % 1)) return String(whole)
  return `${whole || ''}½`
}

/** "3½ stars" — for labels and titles, where "3.5 stars" reads like a measurement. */
export function formatRating(value: number): string {
  return `${formatRatingCompact(value)} star${value === 1 ? '' : 's'}`
}

/** The rating under a pointer, from its x position across a row of star glyphs.

 * The left half of star *n* reads as `n − ½`, the right half (and the gap after
 * it) as `n`. Left of the first star clamps to half a star, right of the last
 * to five — so a drag can never land outside the scale. Geometry-based rather
 * than per-element hit-testing because a drag with pointer capture keeps
 * reporting to the row even when the pointer is over the gaps (or outside the
 * row entirely), where there is no element to hit.
 */
export function valueFromPointerX(glyphs: Iterable<Element>, clientX: number): number {
  let value = RATING_STEP
  let index = 0
  for (const glyph of glyphs) {
    const rect = glyph.getBoundingClientRect()
    if (clientX >= rect.left) value = index + RATING_STEP
    if (clientX >= rect.left + rect.width / 2) value = index + 1
    index += 1
  }
  return Math.min(RATING_MAX, Math.max(RATING_STEP, value))
}
