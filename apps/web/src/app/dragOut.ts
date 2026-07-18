import type { DragEvent, HTMLAttributes } from 'react'

/** Props spread onto a native drag-out source element. */
export interface FileDragProps {
  draggable: boolean
  onDragStart: HTMLAttributes<HTMLElement>['onDragStart']
}

/**
 * Builds the `draggable`/`onDragStart` pair for a drag-out source (plan 3 §6).
 *
 * `onStartFileDrag` is undefined on the web platform and for unmapped libraries,
 * in which case the element is inert. When present, dragstart hands the resolved
 * library-relative paths to the shell — which validates them and puts the real
 * absolute paths on the OS pasteboard — and cancels the browser's own HTML5 drag
 * so only the native OS drag runs. Paths are resolved lazily at drag time so a
 * selection-aware source reflects the selection as it stands when the drag starts.
 */
export function fileDragProps(
  onStartFileDrag: ((relativePaths: string[]) => void) | undefined,
  resolvePaths: () => string[],
): FileDragProps {
  if (!onStartFileDrag) return { draggable: false, onDragStart: undefined }
  return {
    draggable: true,
    onDragStart: (event: DragEvent) => {
      const paths = resolvePaths()
      if (paths.length === 0) return
      event.preventDefault()
      onStartFileDrag(paths)
    },
  }
}
