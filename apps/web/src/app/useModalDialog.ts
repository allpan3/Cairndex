import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { currentDisplayedBasis, holdEditBasis } from '../api/editBasis'

// Exclude hidden controls without relying on layout measurements unavailable to DOM tests
function visible(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (node.hidden || node.inert || style.display === 'none' || style.visibility === 'hidden')
      return false
    if (
      node.tagName === 'DETAILS' &&
      !node.hasAttribute('open') &&
      !node.querySelector('summary')?.contains(element)
    )
      return false
  }
  return true
}

// Respect native modal top layers as well as the shared viewer and portal dialogs
function topDialog(): HTMLElement | undefined {
  const dialogs = Array.from(
    document.querySelectorAll<HTMLElement>('[aria-modal="true"], dialog[open]'),
  ).filter((element) => !element.matches('dialog:not([open])') && visible(element))
  return dialogs.at(-1)
}

// Keep Tab and Escape in the top dialog and restore the opener without discarding other work
export function useModalDialog(onClose: () => void, pending = false) {
  const ref = useRef<HTMLDivElement>(null)
  const [editBasis] = useState(currentDisplayedBasis)
  useLayoutEffect(() => {
    if (ref.current) return holdEditBasis(editBasis)
  }, [editBasis])
  const [previous] = useState(() => document.activeElement as HTMLElement | null)
  const close = useCallback(() => {
    if (!pending) onClose()
  }, [onClose, pending])
  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  }, [close])

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    root.tabIndex = -1
    const controls = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])',
        ),
      ).filter(visible)
    if (!root.contains(document.activeElement)) (controls()[0] ?? root).focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || topDialog() !== root) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      } else if (event.key === 'Tab') {
        const items = controls()
        const first = items[0] ?? root
        const last = items.at(-1) ?? root
        if (
          !root.contains(document.activeElement) ||
          document.activeElement === root ||
          (event.shiftKey ? document.activeElement === first : document.activeElement === last)
        ) {
          event.preventDefault()
          ;(event.shiftKey ? last : first).focus()
        }
      }
    }
    // Nested pickers handle Escape during capture before a dialog can see it
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      queueMicrotask(() => {
        if (root.isConnected) return
        if (previous?.isConnected) previous.focus({ preventScroll: true })
        else topDialog()?.focus({ preventScroll: true })
      })
    }
  }, [previous])
  return { ref, close }
}
