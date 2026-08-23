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

/** Counts for a batch that ran to the end, with the first failure's reason. */
export interface ImportPartialCounts {
  imported: number
  skipped: number
  failed: number
  /** The first failure's message, which is the part worth acting on. */
  reason?: string
}

/**
 * Report a completed batch that did not import everything, or null when it did.
 *
 * Until now a file that failed mid-batch produced one transient toast and
 * nothing else, so a partial import looked like a whole one — and the owner hit
 * exactly that while watching a video, where the toast fired behind the viewer
 * (2026-08-23). The end of the batch is the moment that cannot be missed.
 */
export function importPartialSummary(result: ImportPartialCounts): string | null {
  const total = result.imported + result.skipped + result.failed
  if (result.failed === 0 && result.skipped === 0) return null
  const problems = []
  if (result.skipped > 0) problems.push(`${result.skipped} skipped`)
  if (result.failed > 0) problems.push(`${result.failed} failed`)
  const detail = result.failed > 0 && result.reason ? ` ${result.reason}` : ''
  return `Added ${result.imported} of ${total} files — ${problems.join(', ')}.${detail}`
}
