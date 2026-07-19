import type { ManualBundleResult } from '../api/client'

/**
 * Appends a per-reason note about supplied items the server could not bundle (a
 * folder's already-bundled members, missing files, or non-media sidecars dragged
 * in alongside real media). `> 0` guards each count so a missing field is a no-op
 * rather than rendering "undefined skipped" (D4 review).
 */
export function withSkipNote(message: string, r: ManualBundleResult): string {
  const parts: string[] = []
  if (r.skipped_already_bundled > 0)
    parts.push(`${r.skipped_already_bundled} already in another bundle`)
  if (r.skipped_missing > 0)
    parts.push(`${r.skipped_missing} missing file${r.skipped_missing === 1 ? '' : 's'}`)
  if (r.skipped_non_media > 0)
    parts.push(`${r.skipped_non_media} non-media item${r.skipped_non_media === 1 ? '' : 's'}`)
  if (parts.length === 0) return message
  return `${message} Skipped ${parts.join(', ')}.`
}
