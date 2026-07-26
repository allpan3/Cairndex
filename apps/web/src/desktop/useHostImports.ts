import { useEffect, useRef, useState } from 'react'

import { importHostDroppedFile, listenHostImportProgress } from '../platform'

/**
 * Copying files dropped from Finder into the active library (plan 4 W5).
 *
 * The desktop counterpart to the File Browser's own upload flow, and separate
 * from it for a reason the shell imposes: Tauri intercepts an OS drop before
 * the webview sees it, so these arrive as absolute paths rather than `File`
 * objects, and only the shell can read them. What the two flows *share* is
 * every rule that matters — one file at a time, a collision asks rather than
 * failing, the answer applies to the file it was about, and each import is
 * undoable on its own.
 *
 * A drop is not scoped to the File Browser, so this lives at the app level: the
 * files land in the folder currently being browsed when the Files surface is
 * open, and in the library root otherwise.
 */

/** An import paused on a name that is already taken. */
export interface HostImportConflict {
  path: string
  /** The name in the way, as the server reported it. */
  conflictingName: string
  /** The files after this one, so answering resumes rather than abandons. */
  remaining: string[]
}

/** Live progress for the file currently uploading, within its batch. */
export interface ImportProgress {
  name: string
  /** 1-based position in the current batch. */
  index: number
  /** How many files this copy-in is transferring in total. */
  total: number
  /** Bytes uploaded for the current file. */
  sent: number
  /** The current file's size in bytes (0 until the first tick). */
  size: number
  /** Smoothed upload rate in bytes/second. */
  rate: number
}

export interface HostImports {
  /** Names currently uploading, in order. */
  importing: string[]
  /** The current file's transfer progress, or null when idle. */
  progress: ImportProgress | null
  conflict: HostImportConflict | null
  copyIn: (paths: string[]) => void
  keepBoth: () => void
  replace: () => void
  dismiss: () => void
}

const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

export function useHostImports({
  libraryId,
  destDir,
  onFlash,
  onImported,
}: {
  libraryId: string | null
  /** The folder being browsed, or '' for the library root. */
  destDir: string
  onFlash: (message: string, undo?: () => void) => void
  /** Refresh whatever is on screen, and undo one completed import. */
  onImported: (operationId: string) => { undo: () => void }
}): HostImports {
  const [importing, setImporting] = useState<string[]>([])
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [conflict, setConflict] = useState<HostImportConflict | null>(null)
  // The file currently uploading, so a progress tick (which only knows a path)
  // can be matched to it, and the previous byte/time sample for rate.
  const current = useRef<{ path: string; name: string; index: number; total: number } | null>(null)
  const sample = useRef<{ sent: number; at: number; rate: number }>({ sent: 0, at: 0, rate: 0 })

  // Bytes-sent ticks arrive on a global event; translate each into progress for
  // the file we are on. Set up once — the refs carry the moving target.
  useEffect(() => {
    let stop = () => {}
    let active = true
    void listenHostImportProgress((tick) => {
      const now = current.current
      if (!now || tick.path !== now.path) return
      const at = performance.now()
      const previous = sample.current
      const seconds = (at - previous.at) / 1000
      const raw = seconds > 0 ? (tick.sent - previous.sent) / seconds : previous.rate
      // Light smoothing so the rate reads steadily rather than jittering.
      const rate = previous.rate === 0 ? raw : previous.rate * 0.6 + raw * 0.4
      sample.current = { sent: tick.sent, at, rate }
      setProgress({
        name: now.name,
        index: now.index,
        total: now.total,
        sent: tick.sent,
        size: tick.total,
        rate: Math.max(0, rate),
      })
    }).then((unsubscribe) => (active ? (stop = unsubscribe) : unsubscribe()))
    return () => {
      active = false
      stop()
    }
  }, [])

  async function run(paths: string[], onConflict?: 'suffix' | 'replace'): Promise<void> {
    if (!libraryId) return
    const total = paths.length
    for (const [index, path] of paths.entries()) {
      const name = nameOf(path)
      setImporting((currentNames) => [...currentNames, name])
      current.current = { path, name, index: index + 1, total }
      sample.current = { sent: 0, at: performance.now(), rate: 0 }
      setProgress({ name, index: index + 1, total, sent: 0, size: 0, rate: 0 })
      try {
        const outcome = await importHostDroppedFile({
          libraryId,
          path,
          destDir,
          // The answer belongs to the file it was about; the rest go back to
          // asking, so a second collision is a second question.
          onConflict: index === 0 ? onConflict : undefined,
        })
        const { undo } = onImported(outcome.operationId)
        onFlash(
          outcome.skipped
            ? `Skipped “${name}” — something with that name is already here.`
            : `Copied “${nameOf(outcome.path)}” into the library.`,
          outcome.skipped ? undefined : undo,
        )
      } catch (failure) {
        const conflicting = conflictName(failure)
        if (conflicting !== null) {
          setConflict({
            path,
            conflictingName: conflicting || name,
            remaining: paths.slice(index + 1),
          })
          // Paused on a question: stop showing progress until the answer resumes.
          current.current = null
          setProgress(null)
          return
        }
        onFlash(hostImportMessage(failure, name))
      } finally {
        setImporting((names) => names.filter((entry) => entry !== name))
      }
    }
    current.current = null
    setProgress(null)
  }

  const answer = (policy: 'suffix' | 'replace') => {
    if (!conflict) return
    const { path, remaining } = conflict
    setConflict(null)
    void run([path, ...remaining], policy)
  }

  return {
    importing,
    progress,
    conflict,
    copyIn: (paths) => {
      if (paths.length > 0) void run(paths)
    },
    keepBoth: () => answer('suffix'),
    replace: () => answer('replace'),
    dismiss: () => setConflict(null),
  }
}

/**
 * The conflicting name if this failure is a path collision, else null.
 *
 * Tauri rejects a command with the serialized error value, not an `Error`, so
 * the shape is checked rather than the type.
 */
export function conflictName(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null
  const error = failure as { code?: unknown; conflictingName?: unknown }
  if (error.code !== 'path_conflict') return null
  return typeof error.conflictingName === 'string' ? error.conflictingName : ''
}

/** A readable reason for a failed host import. */
export function hostImportMessage(failure: unknown, name: string): string {
  if (failure && typeof failure === 'object') {
    const error = failure as { message?: unknown }
    if (typeof error.message === 'string' && error.message) return error.message
  }
  if (failure instanceof Error) return failure.message
  return `Could not copy “${name}” into the library.`
}
