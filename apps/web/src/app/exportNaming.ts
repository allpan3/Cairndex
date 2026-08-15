/**
 * Naming an exported artifact after the file it came from.
 *
 * Shared by the GIF, snapshot and contact-sheet paths so they cannot drift.
 * A display title usually still carries the source's extension, so appending
 * naively yields `clip.mp4.gif` — which the owner reported (2026-08-15) and
 * which the snapshot path used to render as `clip_mp4.png`.
 */

/**
 * `<title without its extension>.<extension>`, with what a filename cannot
 * hold removed.
 *
 * The trailing suffix is dropped only when it looks like an extension —
 * bounded at five characters — so a title that merely contains a dot ("Scene
 * 2.5 rework") survives intact.
 */
export function exportFileName(title: string, extension: string, fallback: string): string {
  const withoutExtension = title.replace(/\.[A-Za-z0-9]{1,5}$/, '')
  const cleaned = (withoutExtension || title).replace(/[\\/:*?"<>|]+/g, ' ').trim()
  return `${cleaned || fallback}.${extension}`
}
