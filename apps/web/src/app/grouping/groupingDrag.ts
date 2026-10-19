import type { DragEvent } from 'react'

export const GROUPING_DRAG = 'application/x-cairndex-grouping'
export type GroupingDrag = { workspace: string; node: string; file?: string }

export function groupingDrag(event: DragEvent, workspace: string | null): GroupingDrag | null {
  try {
    const value = JSON.parse(event.dataTransfer.getData(GROUPING_DRAG)) as GroupingDrag
    return value.workspace === workspace &&
      typeof value.node === 'string' &&
      (value.file === undefined || typeof value.file === 'string')
      ? value
      : null
  } catch {
    return null
  }
}
