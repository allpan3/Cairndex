/**
 * Where the selection lands when a rename box opens on a filename.
 *
 * Renaming a file almost never means retyping its type, so the stem is
 * selected and the extension is left alone — the owner types over
 * `Alpha.Show.S01` and keeps `.mp4` without thinking about it.
 *
 * Asserting that *once*, on focus, is not enough. A rename box opened by a
 * double-click has to compete with the engine's own double-click selection, and
 * the two orderings differ: Chromium resolves its word selection against the
 * text node that the input replaced, so the programmatic selection is the last
 * word and survives; WebKit — the engine the desktop shell runs on — can settle
 * its selection on the newly focused input *after* focus, which is how the
 * extension came to be selected there and not in a browser (owner report,
 * 2026-07-30). Re-asserting on the next frame lands after either ordering. The
 * user cannot have typed within that frame, so there is nothing to fight.
 */
export function selectRenameStem(input: HTMLInputElement): void {
  const dot = input.value.lastIndexOf('.')
  input.setSelectionRange(0, dot > 0 ? dot : input.value.length)
}

/**
 * Focus a freshly mounted rename box and select its stem, twice.
 *
 * Returns a cleanup function, so callers can drop it straight into an effect.
 */
export function focusRenameInput(input: HTMLInputElement): () => void {
  input.focus()
  selectRenameStem(input)
  const frame = requestAnimationFrame(() => selectRenameStem(input))
  return () => cancelAnimationFrame(frame)
}
