/**
 * Synchronous handoff between HTML5 file-drop targets and the window-level
 * safety net (see the net in App).
 *
 * The net must know whether some real target already routed a drop, but it
 * cannot use `defaultPrevented` for that: the net itself preventDefaults every
 * Files drop (that is its whole job — an unhandled drop otherwise *navigates
 * the webview to the dropped file*, with no way back). A module-level flag,
 * like `dnd.ts`, is the reliable channel: targets mark, the net consumes.
 */
let handled = false

/** A drop target routed this Files drop; the net should stay quiet. */
export function markHtmlFileDropHandled(): void {
  handled = true
}

/** Whether the drop that just ended was routed; resets for the next one. */
export function consumeHtmlFileDropHandled(): boolean {
  const was = handled
  handled = false
  return was
}
