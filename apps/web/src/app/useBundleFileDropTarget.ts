import { useState, type DragEvent } from 'react'

import { markHtmlFileDropHandled } from './htmlFileDrop'

/** The import-and-link action shared by every drop target for one bundle */
export type BundleFileDropHandler = (bundleId: string, files: File[]) => void

/** HTML file-drop behavior shared by bundle cards and the Bundle Inspector */
export function useBundleFileDropTarget(bundleId: string, onDropFiles?: BundleFileDropHandler) {
  const [fileDropOver, setFileDropOver] = useState(false)

  return {
    fileDropOver,
    dropProps: onDropFiles
      ? {
          onDragOver: (event: DragEvent<HTMLElement>) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            event.stopPropagation()
            event.dataTransfer.dropEffect = 'copy'
            setFileDropOver(true)
          },
          onDragLeave: (event: DragEvent<HTMLElement>) => {
            const next = event.relatedTarget
            if (next instanceof Node && event.currentTarget.contains(next)) return
            setFileDropOver(false)
          },
          onDrop: (event: DragEvent<HTMLElement>) => {
            if (!event.dataTransfer.types.includes('Files')) return
            event.preventDefault()
            markHtmlFileDropHandled()
            setFileDropOver(false)
            onDropFiles(bundleId, [...event.dataTransfer.files])
          },
        }
      : {},
  }
}
