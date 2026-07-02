/** Vertical hierarchy guide lines for a tree row — one thin rule per ancestor
 * level, so nesting depth reads at a glance. Replaces plain padding indent. */
export function PickGuides({ depth }: { depth: number }) {
  if (depth <= 0) return null
  return (
    <span className="pick-guides" aria-hidden>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className="pick-guide" />
      ))}
    </span>
  )
}
