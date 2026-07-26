/**
 * Marks the document when the shell window has no title bar of its own.
 *
 * The macOS window uses `titleBarStyle: Overlay`, so the app surface starts at
 * the very top of the window and the traffic lights float over its top-left
 * corner — one continuous surface instead of a grey system bar stacked above
 * the app. The CSS that reserves that corner (`.sidebar__titlebar`) and the
 * `data-tauri-drag-region` strips that replace the system bar's dragging are
 * scoped to this attribute, so a browser tab is untouched — and so is a future
 * Windows/Linux shell, which keeps its own decorations.
 */
export function markOverlayTitleBar(doc: Document, userAgent: string): void {
  if (!userAgent.includes('Macintosh')) return
  doc.documentElement.dataset.titlebar = 'overlay'
}
