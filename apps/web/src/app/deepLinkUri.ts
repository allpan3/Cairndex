/**
 * Builds and copies `cairndex://` URIs (plan 3 §7).
 *
 * D5b shipped deep-link *handling* with nothing in the product that produces a
 * link, so the only way to exercise one was to assemble it by hand from API ids.
 * This closes that gap.
 */

export type DeepLinkKind = 'bundle' | 'collection'

/**
 * Builds the canonical URI for one target.
 *
 * The library id is always included. A link is most useful pasted somewhere and
 * opened later, by which point the active library may be a different one — and a
 * link that silently resolves against the wrong library would open the wrong
 * thing. Both segments are percent-encoded, matching the shell's decode side.
 */
export function buildDeepLinkUri(kind: DeepLinkKind, id: string, libraryId: string): string {
  return `cairndex://${kind}/${encodeURIComponent(id)}?library=${encodeURIComponent(libraryId)}`
}

/**
 * Copies text to the clipboard, returning whether it landed.
 *
 * `navigator.clipboard` needs a secure context and a user gesture; a context-menu
 * click supplies the gesture, but the fallback keeps this working if the API is
 * unavailable (older WebKit, or a non-secure origin during development).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the legacy path rather than failing outright.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    // Keep it out of view and out of the tab order while it must stay focusable.
    area.setAttribute('aria-hidden', 'true')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    area.style.pointerEvents = 'none'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
