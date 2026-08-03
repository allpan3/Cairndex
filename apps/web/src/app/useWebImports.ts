import { useEffect, useRef, useState } from 'react'

import { PathConflictError, type ConflictPolicy, type ImportResult } from '../api/client'
import { useFileOperations } from '../api/hooks'
import { importStoppedSummary, type ImportActivity } from './importActivity'

/** One browser import paused before a collision answer */
export interface WebImportConflict {
  conflictingName: string
}

/** The durable outcomes known when a browser import batch settles */
export interface WebImportBatchResult {
  imported: ImportResult[]
  skipped: number
  failed: number
  stopped: boolean
  interrupted: number
  notAttempted: number
}

/** Optional behavior supplied by one browser import caller */
export interface WebImportOptions {
  /** A policy applied to every file, used by bundle-target drops */
  onConflict?: ConflictPolicy
  /** Ordinary File Browser imports keep their per-file Undo notice */
  announceEach?: boolean
  onSettled?: (result: WebImportBatchResult) => void | Promise<void>
}

/** Mutable state for the browser batch currently in progress */
interface WebImportBatch {
  id: string
  files: File[]
  destDir: string
  options: WebImportOptions
  index: number
  imported: ImportResult[]
  skipped: number
  failed: number
  stopping: boolean
  inFlight: boolean
}

/** Browser-owned sequential import batches, including prompt in-flight abort */
export function useWebImports({
  onFlash,
}: {
  onFlash: (message: string, undo?: () => void) => void
}) {
  const { importOne, undo } = useFileOperations()
  const [activity, setActivity] = useState<ImportActivity | null>(null)
  const [conflict, setConflict] = useState<WebImportConflict | null>(null)
  const batchRef = useRef<WebImportBatch | null>(null)
  const controllerRef = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const batch = batchRef.current
      if (batch) batch.stopping = true
      controllerRef.current?.abort()
    }
  }, [])

  const copyIn = (files: File[], destDir: string, options: WebImportOptions = {}) => {
    if (files.length === 0) return false
    if (batchRef.current) {
      onFlash('An import is already in progress.')
      return false
    }
    const batch: WebImportBatch = {
      id: newBatchId(),
      files,
      destDir,
      options,
      index: 0,
      imported: [],
      skipped: 0,
      failed: 0,
      stopping: false,
      inFlight: false,
    }
    batchRef.current = batch
    void run(batch)
    return true
  }

  const answer = (policy: 'suffix' | 'replace') => {
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
    setActivity((current) => (current ? { ...current, status: 'stopping' } : current))
    if (batch.inFlight) controllerRef.current?.abort()
    else void settle(batch, true, 0)
  }

  return {
    activity,
    conflict,
    copyIn,
    keepBoth: () => answer('suffix'),
    replace: () => answer('replace'),
    dismiss: stop,
    stop,
  }

  /** Continue the current batch until it finishes, stops, or needs an answer */
  async function run(batch: WebImportBatch, oneShotPolicy?: ConflictPolicy): Promise<void> {
    while (batch.index < batch.files.length) {
      if (batch.stopping) {
        await settle(batch, true, 0)
        return
      }
      const file = batch.files[batch.index] as File
      const controller = new AbortController()
      controllerRef.current = controller
      batch.inFlight = true
      setActivity({
        id: batch.id,
        name: file.name,
        index: batch.index + 1,
        total: batch.files.length,
        status: 'running',
      })
      try {
        const result = await importOne.mutateAsync({
          file,
          destDir: batch.destDir,
          onConflict: oneShotPolicy ?? batch.options.onConflict,
          signal: controller.signal,
        })
        oneShotPolicy = undefined
        if (result.skipped) {
          batch.skipped += 1
          if (batch.options.announceEach !== false) {
            onFlash(`Skipped “${file.name}” — something with that name is already here.`)
          }
        } else {
          batch.imported.push(result)
          if (batch.options.announceEach !== false) {
            onFlash(`Copied “${nameOf(result.path)}” into the library.`, () =>
              undo.mutate(result.operation.id, {
                onSuccess: () => onFlash('Undone.'),
                onError: (failure) => onFlash(messageOf(failure)),
              }),
            )
          }
        }
        batch.index += 1
        batch.inFlight = false
        if (batch.stopping) {
          await settle(batch, true, 0)
          return
        }
      } catch (failure) {
        if (batch.stopping || isAbort(failure)) {
          await settle(batch, true, 1)
          return
        }
        if (failure instanceof PathConflictError) {
          batch.inFlight = false
          setConflict({ conflictingName: failure.entryName || file.name })
          setActivity({
            id: batch.id,
            name: file.name,
            index: batch.index + 1,
            total: batch.files.length,
            status: 'waiting',
          })
          return
        }
        batch.failed += 1
        batch.index += 1
        batch.inFlight = false
        onFlash(messageOf(failure))
      } finally {
        controllerRef.current = null
      }
    }
    await settle(batch, false, 0)
  }

  /** Publish the outcome after any caller-specific linking has finished */
  async function settle(
    batch: WebImportBatch,
    stopped: boolean,
    interrupted: number,
  ): Promise<void> {
    if (batchRef.current !== batch) return
    batchRef.current = null
    controllerRef.current = null
    setConflict(null)
    const result: WebImportBatchResult = {
      imported: batch.imported,
      skipped: batch.skipped,
      failed: batch.failed,
      stopped,
      interrupted,
      notAttempted: Math.max(0, batch.files.length - batch.index - interrupted),
    }
    if (mountedRef.current) setActivity(null)
    if (mountedRef.current) {
      try {
        await batch.options.onSettled?.(result)
      } catch (failure) {
        if (mountedRef.current) onFlash(messageOf(failure))
      }
    }
    if (!mountedRef.current) return
    if (stopped) {
      onFlash(
        importStoppedSummary({
          imported: result.imported.length,
          skipped: result.skipped,
          failed: result.failed,
          interrupted: result.interrupted,
          notAttempted: result.notAttempted,
        }),
      )
    }
  }
}

/** Create one identifier for a sidebar row and its AbortController */
function newBatchId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}`
}

/** Return the final segment of a library-relative path */
function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/** Distinguish a deliberate fetch abort from an ordinary upload failure */
function isAbort(failure: unknown): boolean {
  return failure instanceof DOMException && failure.name === 'AbortError'
}

/** Give an unknown browser-side failure readable fallback copy */
function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  return 'That could not be done.'
}
