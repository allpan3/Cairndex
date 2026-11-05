import { useRef, type DragEvent } from 'react'
import { isHostDragOutActive } from '../platform'
import { isBlockingSurfaceOpen } from './fileDrop'

export const MAX_INCOMING_FILES = 128
export const MAX_INCOMING_BYTES = 128 * 1024 ** 3

export function incomingFilesError(files: File[]): string | null {
  if (files.length === 0) return 'Drop regular files. Folder drops are not supported.'
  if (files.length > MAX_INCOMING_FILES) return 'Select at most 128 files at a time.'
  if (files.some((file) => file.size > MAX_INCOMING_BYTES))
    return 'Each file must be 128 GiB or smaller.'
  if (files.some((file) => !file.name || /[/\\]/.test(file.name) || file.name.startsWith('.')))
    return 'Select regular files with visible names.'
  return null
}

/** WebKit keeps HTML drops enabled. File objects carry bytes, never host paths. */
export function useIncomingFileDrop(
  enabled: boolean,
  onFiles: (files: File[]) => void,
  onError: (message: string) => void,
) {
  const selfDrag = useRef(false)
  const isFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files')
  return {
    onDragEnterCapture: (event: DragEvent) => {
      if (isFiles(event) && isHostDragOutActive()) selfDrag.current = true
    },
    onDragLeaveCapture: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        selfDrag.current = false
    },
    onDragOverCapture: (event: DragEvent) => {
      if (!isFiles(event)) return
      event.preventDefault()
      if (isHostDragOutActive()) selfDrag.current = true
      event.dataTransfer.dropEffect =
        enabled && !isBlockingSurfaceOpen() && !selfDrag.current ? 'copy' : 'none'
    },
    onDropCapture: (event: DragEvent) => {
      if (!isFiles(event)) return
      event.preventDefault()
      // A bundle card that takes files receives a checked drop itself
      const card = (event.target as Element | null)?.closest?.('[data-file-drop-bundle]')
      const own = selfDrag.current || isHostDragOutActive()
      selfDrag.current = false
      const refuse = (message: string | null) => {
        event.stopPropagation()
        if (message) onError(message)
      }
      if (own) return refuse(null)
      if (!enabled) return refuse('File copies are unavailable in the current library state.')
      if (isBlockingSurfaceOpen()) return refuse('Close the open dialog before dragging files in.')
      if (
        Array.from(event.dataTransfer.items).some((item) => item.webkitGetAsEntry?.()?.isDirectory)
      )
        return refuse('Folder drops are not supported. Select the files inside.')
      const files = Array.from(event.dataTransfer.files)
      const error = incomingFilesError(files)
      if (error) return refuse(error)
      if (card) return
      event.stopPropagation()
      onFiles(files)
    },
  }
}
