/**
 * Sibling filenames usually differ at the *end* — `…Part1.mp4`, `…Part2.mp4` —
 * but a narrow rail truncates the end, so rows sharing a long prefix become
 * identical on screen (owner, 2026-07-27). Middle-ellipsis fixes that bluntly,
 * cutting every name in the same arbitrary place. This does it precisely: find
 * what each name actually shares with its siblings, and let *that* collapse
 * while the part that tells them apart keeps its width.
 *
 * The shared run is computed per name, against the sibling it most resembles,
 * not across the whole list — one unrelated `poster.jpg` in the bundle must not
 * stop `…Part1` and `…Part2` from collapsing their common stem.
 */

/** Characters a name naturally breaks at, so the split lands between words. */
const SEPARATOR = /[ \-_.·()[\]]/

/** Shared prefix below this length stays plain: splitting a short run adds a
 * seam without saving meaningful space. */
const MIN_SHARED = 8

function commonPrefix(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charAt(i) === b.charAt(i)) i += 1
  return i
}

/**
 * For each name, how many leading characters to collapse — 0 for "render it
 * plain". The cut is snapped back to a separator so the seam is a word
 * boundary, and a cut that would leave nothing distinct is dropped: identical
 * labels cannot be told apart by any amount of trimming.
 */
export function collapsePrefixLengths(names: string[]): number[] {
  return names.map((name, index) => {
    let best = 0
    for (let other = 0; other < names.length; other += 1) {
      if (other === index) continue
      const shared = commonPrefix(name, names[other] as string)
      if (shared > best) best = shared
    }
    // Snap back to the last separator inside the shared run. A raw character
    // prefix ends mid-token ("…FirstBigDick - Part") and would dim half a word.
    while (best > 0 && !SEPARATOR.test(name.charAt(best - 1))) best -= 1
    if (best < MIN_SHARED) return 0
    if (best >= name.length) return 0
    return best
  })
}
