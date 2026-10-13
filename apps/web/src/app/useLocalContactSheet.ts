import { useRef, useState } from 'react'
import { replicaRequest } from '../api/replicas'
import type { components } from '../api/schema'
import { contactSheetTargetForFile, type ContactSheetTarget } from './contactSheetExport'

type LocalMedia = components['schemas']['LocalMediaRead']

/**
 * The contact-sheet dialog for a catalog file opened outside the viewer.
 *
 * Catalog rows carry no local facts, and the sheet header prints the size,
 * duration and codecs. So the file is observed on this device first, and only
 * an available file opens the dialog. A later request replaces an earlier one.
 */
export function useLocalContactSheet(
  library: string | null | undefined,
  onError: (message: string) => void,
) {
  const [target, setTarget] = useState<ContactSheetTarget | null>(null)
  const request = useRef(0)
  async function open(fileId: string) {
    if (!library) return
    const id = ++request.current
    try {
      const local = await replicaRequest<LocalMedia>(library, `/media/files/${fileId}`)
      if (id !== request.current) return
      if (local.state !== 'available')
        throw new Error(local.message ?? 'Media unavailable on this device.')
      setTarget(contactSheetTargetForFile(local.file))
    } catch (reason) {
      if (id === request.current) onError((reason as Error).message)
    }
  }
  return {
    target,
    open: (fileId: string) => void open(fileId),
    close: () => setTarget(null),
  }
}
