/**
 * Tags copied from one bundle's pill list, for pasting onto another.
 *
 * Session-scoped and deliberately not persisted: it holds a selection the user
 * made a moment ago, not a preference. It lives outside React so switching
 * bundles — which unmounts the editor — does not empty it, which is the whole
 * point of a copy (owner, 2026-07-27).
 */

let copied: string[] = []

export function getCopiedTags(): string[] {
  return copied
}

export function setCopiedTags(tagIds: string[]): void {
  copied = [...tagIds]
}
