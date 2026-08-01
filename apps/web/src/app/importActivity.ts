export type ImportActivityStatus = 'waiting' | 'running' | 'stopping'

/** One client-owned import batch shown beside the background-job rows */
export interface ImportActivity {
  id: string
  name: string
  /** 1-based position of the current file in the original batch */
  index: number
  total: number
  status: ImportActivityStatus
  /** Desktop-only byte progress for the current file */
  sent?: number
  size?: number
  rate?: number
}

/** Counts used by the common browser/desktop stopped-batch summary */
export interface ImportStopCounts {
  imported: number
  skipped: number
  failed: number
  interrupted: number
  notAttempted: number
}

/** Report a partial batch without implying that completed imports were undone */
export function importStoppedSummary(result: ImportStopCounts): string {
  const parts = [`${result.imported} imported`, `${result.skipped} skipped`]
  if (result.failed > 0) parts.push(`${result.failed} failed`)
  if (result.interrupted > 0) parts.push(`${result.interrupted} stopped mid-upload`)
  parts.push(`${result.notAttempted} not attempted`)
  const retained =
    result.imported > 0
      ? ' Imported files remain in the library and can each be undone.'
      : ' No files were imported.'
  return `Import stopped: ${parts.join(', ')}.${retained}`
}
