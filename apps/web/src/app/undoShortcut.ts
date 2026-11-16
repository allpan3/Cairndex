import { useEffect, useRef } from 'react'

/** The newest change one source of Undo can take back, and how. */
export interface Undoable {
  /** From `undoStamp`: orders changes across sources */
  at: number
  run: () => void
}

let clock = 0

/** A stamp for a change that can be undone, later than every earlier one. */
export function undoStamp(): number {
  clock += 1
  return clock
}

/** True when ⌘Z belongs to the focused field, an open dialog or a menu rather than to Undo. */
export function ownedElsewhere(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : null
  return (
    event.defaultPrevented ||
    Boolean(
      target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'),
    ) ||
    Boolean(document.querySelector('[role="menu"]')) ||
    Array.from(document.querySelectorAll('[aria-modal="true"]')).some(
      (dialog) => !dialog.matches('dialog:not([open])'),
    )
  )
}

/**
 * The one ⌘Z (Ctrl+Z) for every source of Undo: organizing changes and file
 * operations. It takes back whichever change happened last, so pressing it
 * again walks back through both in order, never undoing an older file
 * operation ahead of a newer organizing change or the reverse.
 */
export function useUndoShortcut(sources: () => (Undoable | null)[]): void {
  const read = useRef(sources)
  useEffect(() => {
    read.current = sources
  })
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== 'z' ||
        ownedElsewhere(event)
      )
        return
      let newest: Undoable | null = null
      for (const item of read.current()) if (item && (!newest || item.at > newest.at)) newest = item
      if (!newest) return
      event.preventDefault()
      newest.run()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [])
}
