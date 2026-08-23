import { useEffect, useRef, useState } from 'react'

import {
  cancelHostImportBatch,
  finishHostImportBatch,
  importHostDroppedFile,
  listenHostImportProgress,
  startHostImportBatch,
} from '../platform'
import { importStoppedSummary, type ImportActivity } from '../app/importActivity'

/** An import paused on a name that is already taken */
export interface HostImportConflict {
  conflictingName: string
}

/** Mutable state for the desktop batch currently in progress */
interface HostImportBatch {
  id: string
  paths: string[]
  index: number
  imported: number
  skipped: number
  failed: number
  stopping: boolean
  inFlight: boolean
  prepared: boolean
}

/** Desktop import state and controls exposed to the app shell */
export interface HostImports {
  activity: ImportActivity | null
  conflict: HostImportConflict | null
  copyIn: (paths: string[]) => void
  keepBoth: () => void
  replace: () => void
  skip: () => void
  dismiss: () => void
  stop: () => void
}

/** Return the basename of a dropped macOS, Windows, or POSIX path */
const nameOf = (path: string): string => path.split(/[\\/]/).pop() ?? path

/** Copy Finder-dropped paths through the shell's cancellable streaming bridge */
export function useHostImports({
  libraryId,
  destDir,
  onFlash,
  onImported,
}: {
  libraryId: string | null
  /** The folder being browsed, or '' for the library root */
  destDir: string
  onFlash: (message: string, undo?: () => void) => void
  /** Refresh whatever is on screen, and undo one completed import */
  onImported: (operationId: string) => { undo: () => void }
}): HostImports {
  const [activity, setActivity] = useState<ImportActivity | null>(null)
  const [conflict, setConflict] = useState<HostImportConflict | null>(null)
  const batchRef = useRef<HostImportBatch | null>(null)
  // The file currently uploading, so a global progress tick can be matched to
  // it, plus the previous byte/time sample for the smoothed rate
  const current = useRef<{
    batchId: string
    path: string
    name: string
    index: number
    total: number
  } | null>(null)
  const sample = useRef<{ sent: number; at: number; rate: number }>({ sent: 0, at: 0, rate: 0 })
  const mountedRef = useRef(true)

  useEffect(() => {
    let unsubscribe = () => {}
    let active = true
    void listenHostImportProgress((tick) => {
      const now = current.current
      if (!now || tick.path !== now.path) return
      const at = performance.now()
      const previous = sample.current
      const seconds = (at - previous.at) / 1000
      const raw = seconds > 0 ? (tick.sent - previous.sent) / seconds : previous.rate
      const rate = previous.rate === 0 ? raw : previous.rate * 0.6 + raw * 0.4
      sample.current = { sent: tick.sent, at, rate }
      setActivity((shown) => ({
        id: now.batchId,
        name: now.name,
        index: now.index,
        total: now.total,
        status: shown?.status === 'stopping' ? 'stopping' : 'running',
        sent: tick.sent,
        size: tick.total,
        rate: Math.max(0, rate),
      }))
    }).then((stop) => (active ? (unsubscribe = stop) : stop()))
    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const batch = batchRef.current
      if (!batch) return
      batch.stopping = true
      if (batch.prepared) void cancelHostImportBatch(batch.id).catch(() => undefined)
    }
  }, [])

  const copyIn = (paths: string[]) => {
    if (!libraryId || paths.length === 0) return
    if (batchRef.current) {
      onFlash('An import is already in progress.')
      return
    }
    const batch: HostImportBatch = {
      id: newBatchId(),
      paths,
      index: 0,
      imported: 0,
      skipped: 0,
      failed: 0,
      stopping: false,
      inFlight: false,
      prepared: false,
    }
    batchRef.current = batch
    setActivity({
      id: batch.id,
      name: nameOf(paths[0] as string),
      index: 1,
      total: paths.length,
      status: 'waiting',
    })
    void start(batch)
  }

  const answer = (policy: 'suffix' | 'replace' | 'skip') => {
    const batch = batchRef.current
    if (!batch || !conflict || batch.stopping || batch.inFlight) return
    setConflict(null)
    void run(batch, policy)
  }

  const stop = () => {
    const batch = batchRef.current
    if (!batch || batch.stopping) return
    batch.stopping = true
    setConflict(null)
    setActivity((shown) => (shown ? { ...shown, status: 'stopping' } : shown))
    if (batch.prepared && batch.inFlight) {
      void cancelHostImportBatch(batch.id).catch((failure) => {
        if (mountedRef.current) onFlash(hostImportMessage(failure, 'this import'))
      })
    } else if (batch.prepared) void settle(batch, true, 0)
  }

  return {
    activity,
    conflict,
    copyIn,
    keepBoth: () => answer('suffix'),
    replace: () => answer('replace'),
    // Skips this file and continues; `dismiss` abandons what is left.
    skip: () => answer('skip'),
    dismiss: stop,
    stop,
  }

  /** Open the native cancellation scope before streaming the first file */
  async function start(batch: HostImportBatch): Promise<void> {
    try {
      await startHostImportBatch(batch.id)
      batch.prepared = true
      if (batch.stopping) {
        await cancelHostImportBatch(batch.id)
        await settle(batch, true, 0)
        return
      }
      await run(batch)
    } catch (failure) {
      if (batch.prepared) await finishHostImportBatch(batch.id).catch(() => undefined)
      batchRef.current = null
      if (mountedRef.current) {
        setActivity(null)
        onFlash(hostImportMessage(failure, nameOf(batch.paths[0] as string)))
      }
    }
  }

  /** Continue sequential uploads until completion, stop, or a collision */
  async function run(
    batch: HostImportBatch,
    oneShotPolicy?: 'suffix' | 'replace' | 'skip',
  ): Promise<void> {
    if (!libraryId) return
    while (batch.index < batch.paths.length) {
      if (batch.stopping) {
        await settle(batch, true, 0)
        return
      }
      const path = batch.paths[batch.index] as string
      const name = nameOf(path)
      current.current = {
        batchId: batch.id,
        path,
        name,
        index: batch.index + 1,
        total: batch.paths.length,
      }
      sample.current = { sent: 0, at: performance.now(), rate: 0 }
      batch.inFlight = true
      setActivity({
        id: batch.id,
        name,
        index: batch.index + 1,
        total: batch.paths.length,
        status: 'running',
        sent: 0,
        size: 0,
        rate: 0,
      })
      try {
        const outcome = await importHostDroppedFile({
          libraryId,
          batchId: batch.id,
          path,
          destDir,
          onConflict: oneShotPolicy,
        })
        oneShotPolicy = undefined
        if (outcome.skipped) {
          batch.skipped += 1
          onFlash(`Skipped “${name}” — something with that name is already here.`)
        } else {
          batch.imported += 1
          const { undo } = onImported(outcome.operationId)
          onFlash(`Copied “${nameOf(outcome.path)}” into the library.`, undo)
        }
        batch.index += 1
        batch.inFlight = false
        if (batch.stopping) {
          await settle(batch, true, 0)
          return
        }
      } catch (failure) {
        if (batch.stopping || isHostImportCancelled(failure)) {
          await settle(batch, true, 1)
          return
        }
        const conflicting = conflictName(failure)
        if (conflicting !== null) {
          batch.inFlight = false
          current.current = null
          setConflict({ conflictingName: conflicting || name })
          setActivity({
            id: batch.id,
            name,
            index: batch.index + 1,
            total: batch.paths.length,
            status: 'waiting',
          })
          return
        }
        batch.failed += 1
        batch.index += 1
        batch.inFlight = false
        onFlash(hostImportMessage(failure, name))
      } finally {
        current.current = null
      }
    }
    await settle(batch, false, 0)
  }

  /** Close the native cancellation scope and publish a partial-batch summary */
  async function settle(
    batch: HostImportBatch,
    stopped: boolean,
    interrupted: number,
  ): Promise<void> {
    if (batchRef.current !== batch) return
    batchRef.current = null
    current.current = null
    setConflict(null)
    await finishHostImportBatch(batch.id).catch(() => undefined)
    if (!mountedRef.current) return
    setActivity(null)
    if (stopped) {
      onFlash(
        importStoppedSummary({
          imported: batch.imported,
          skipped: batch.skipped,
          failed: batch.failed,
          interrupted,
          notAttempted: Math.max(0, batch.paths.length - batch.index - interrupted),
        }),
      )
    }
  }
}

/** The conflicting name if this serialized Tauri error is a path collision */
export function conflictName(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null
  const error = failure as { code?: unknown; conflictingName?: unknown }
  if (error.code !== 'path_conflict') return null
  return typeof error.conflictingName === 'string' ? error.conflictingName : ''
}

/** Whether the shell stopped the request body on purpose */
export function isHostImportCancelled(failure: unknown): boolean {
  return Boolean(
    failure &&
    typeof failure === 'object' &&
    (failure as { code?: unknown }).code === 'import_cancelled',
  )
}

/** A readable reason for a failed host import */
export function hostImportMessage(failure: unknown, name: string): string {
  if (failure && typeof failure === 'object') {
    const error = failure as { message?: unknown }
    if (typeof error.message === 'string' && error.message) return error.message
  }
  if (failure instanceof Error) return failure.message
  return `Could not copy “${name}” into the library.`
}

/** Create one inert identifier for the shell's cancellation-token map */
function newBatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}`
}
