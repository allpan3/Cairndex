import { useState } from 'react'

import { PathConflictError } from '../api/client'
import { useFileOperations } from '../api/hooks'

/**
 * File Browser write affordances: inline rename and New Folder (ADR-0013 W1).
 *
 * Kept out of `FileBrowser.tsx` because it is a small state machine of its own —
 * what is being edited, what collided, what can be undone — and the browser is
 * already the largest component in the app.
 *
 * Two interaction rules the server's shape dictates:
 *
 * - **A collision is a question, not an error.** The default policy is `fail`,
 *   so the first attempt asks; the dialog re-issues the same rename with an
 *   explicit policy. Nothing has moved when it appears.
 * - **Every completed operation offers Undo**, because the journal makes the
 *   inverse exact rather than best-effort — the toast is where that shows up.
 */

/**
 * An operation paused on a name that is already taken.
 *
 * One type for both operations that can hit one, because the *question* is
 * identical — "something is already called that; what should happen?" — and so
 * is the dialog. Only the resumption differs, which is what `kind` selects.
 */
type PendingConflict =
  | { kind: 'rename'; path: string; newName: string; conflictingName: string }
  // A move is one request for the whole selection, so the answer applies to the
  // batch (the Eagle/Finder "apply to all") and re-issues it in one call.
  | { kind: 'move'; paths: string[]; destDir: string; conflictingName: string }

/** Files the owner has asked to delete, awaiting confirmation. */
export interface PendingDelete {
  paths: string[]
  /** How many of them are linked into a bundle — the part worth pausing over. */
  linkedCount: number
}

/** Entries the owner has asked to move, awaiting a destination directory. */
export interface PendingMove {
  paths: string[]
}

export interface FileWriteActions {
  /** The entry currently being renamed inline, if any. */
  renamingPath: string | null
  startRename: (path: string) => void
  cancelRename: () => void
  submitRename: (path: string, newName: string) => void
  /** True while the New Folder row is open for a name. */
  creatingFolder: boolean
  startNewFolder: () => void
  cancelNewFolder: () => void
  submitNewFolder: (name: string) => void
  busy: boolean
  /** The collision prompt, or null. Render with `<ConflictDialog />`. */
  conflict: PendingConflict | null
  keepBoth: () => void
  replace: () => void
  dismissConflict: () => void
  /** Copy external files into the directory being browsed. */
  importFiles: (files: File[]) => void
  /** The delete confirmation, or null. Render with `<DeleteDialog />`. */
  pendingDelete: PendingDelete | null
  askToDelete: (paths: string[], linkedCount: number) => void
  confirmDelete: () => void
  dismissDelete: () => void
  /** The destination picker, or null. Render with `<DirectoryPicker />`. */
  pendingMove: PendingMove | null
  askToMove: (paths: string[]) => void
  moveTo: (destDir: string) => void
  dismissMove: () => void
}

export function useFileWriteActions({
  currentPath,
  onFlash,
  onImportFiles,
}: {
  /** The directory being browsed; New Folder is created inside it. */
  currentPath: string
  /** Show a message, with an Undo action when the operation has an inverse. */
  onFlash: (message: string, undo?: () => void) => void
  /** The app-level batch owns progress and cancellation across navigation */
  onImportFiles?: (files: File[], destDir: string) => void
}): FileWriteActions {
  const { rename, mkdir, undo, trash, move } = useFileOperations()
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [conflict, setConflict] = useState<PendingConflict | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null)

  const undoLater = (operationId: string) => () => {
    undo.mutate(operationId, {
      onSuccess: () => onFlash('Undone.'),
      onError: (failure) => onFlash(messageOf(failure)),
    })
  }

  const runRename = (path: string, newName: string, onConflict?: 'suffix' | 'replace') => {
    rename.mutate(
      { path, newName, onConflict },
      {
        onSuccess: (result) => {
          setConflict(null)
          const settled = result.path.split('/').pop() ?? result.path
          onFlash(
            // Say the name it *landed on*: with "keep both" the server chose it,
            // not the owner, and a toast reporting the requested name would be
            // quietly wrong. A replace kept the name but displaced a file, which
            // is the part the owner may want back.
            settled !== newName
              ? `Renamed to “${settled}” to keep both.`
              : onConflict === 'replace'
                ? `Replaced “${settled}”. The old file is in the trash.`
                : `Renamed to “${settled}”.`,
            undoLater(result.operation.id),
          )
        },
        onError: (failure) => {
          if (failure instanceof PathConflictError) {
            setConflict({
              kind: 'rename',
              path,
              newName,
              conflictingName: failure.entryName || newName,
            })
            return
          }
          setConflict(null)
          onFlash(messageOf(failure))
        },
      },
    )
  }

  const runMove = (paths: string[], destDir: string, onConflict?: 'suffix' | 'replace') => {
    move.mutate(
      { paths, destDir, onConflict },
      {
        onSuccess: (result) => {
          setConflict(null)
          const where = destName(destDir)
          if (result.skipped) {
            // Everything asked for was already in that directory or skipped.
            onFlash(`Nothing to move — already in ${where}.`)
            return
          }
          const failed = result.failed_paths ?? []
          const moved = paths.length - failed.length
          const movedMessage =
            moved === 1
              ? `Moved “${nameOf(result.path)}” to ${where}.`
              : `Moved ${moved} items to ${where}.`
          onFlash(
            failed.length === 0
              ? movedMessage
              : `${movedMessage} ${
                  failed.length === 1
                    ? `“${nameOf(failed[0] as string)}” could not be moved.`
                    : `${failed.length} items could not be moved.`
                }`,
            undoLater(result.operation.id),
          )
        },
        onError: (failure) => {
          if (failure instanceof PathConflictError) {
            setConflict({
              kind: 'move',
              paths,
              destDir,
              conflictingName: failure.entryName || nameOf(paths[0] ?? ''),
            })
            return
          }
          setConflict(null)
          onFlash(messageOf(failure))
        },
      },
    )
  }

  return {
    renamingPath,
    startRename: (path) => {
      setCreatingFolder(false)
      setRenamingPath(path)
    },
    cancelRename: () => setRenamingPath(null),
    submitRename: (path, newName) => {
      setRenamingPath(null)
      const current = path.split('/').pop()
      if (!newName.trim() || newName === current) return // nothing to do
      runRename(path, newName.trim())
    },
    creatingFolder,
    startNewFolder: () => {
      setRenamingPath(null)
      setCreatingFolder(true)
    },
    cancelNewFolder: () => setCreatingFolder(false),
    submitNewFolder: (name) => {
      setCreatingFolder(false)
      const trimmed = name.trim()
      if (!trimmed) return
      const path = currentPath ? `${currentPath}/${trimmed}` : trimmed
      mkdir.mutate(path, {
        onSuccess: (result) => onFlash(`Created “${trimmed}”.`, undoLater(result.operation.id)),
        onError: (failure) => onFlash(messageOf(failure)),
      })
    },
    busy:
      rename.isPending || mkdir.isPending || undo.isPending || trash.isPending || move.isPending,
    conflict,
    keepBoth: () => answerConflict('suffix'),
    replace: () => answerConflict('replace'),
    dismissConflict: () => setConflict(null),
    pendingDelete,
    askToDelete: (paths, linkedCount) => {
      if (paths.length > 0) setPendingDelete({ paths, linkedCount })
    },
    confirmDelete: () => {
      const target = pendingDelete
      if (!target) return
      setPendingDelete(null)
      trash.mutate(target.paths, {
        onSuccess: (result) => {
          // A delete can partly fail — one file of a multi-select hitting a
          // permissions error on a share. The rest still moved, so this is a
          // success that names what it could not take rather than an error
          // that would leave the owner guessing which is which.
          const failed = result.failed_paths ?? []
          const moved = target.paths.length - failed.length
          const movedMessage =
            moved === 1
              ? `Moved “${nameOf((result.path || target.paths[0]) as string)}” to the trash.`
              : `Moved ${moved} items to the trash.`
          onFlash(
            failed.length === 0
              ? movedMessage
              : `${movedMessage} ${
                  failed.length === 1
                    ? `“${nameOf(failed[0] as string)}” could not be moved.`
                    : `${failed.length} items could not be moved.`
                }`,
            undoLater(result.operation.id),
          )
        },
        onError: (failure) => onFlash(messageOf(failure)),
      })
    },
    dismissDelete: () => setPendingDelete(null),
    pendingMove,
    askToMove: (paths) => {
      if (paths.length > 0) setPendingMove({ paths })
    },
    moveTo: (destDir) => {
      const target = pendingMove
      if (!target) return
      setPendingMove(null)
      runMove(target.paths, destDir)
    },
    dismissMove: () => setPendingMove(null),
    importFiles: (files) => {
      if (files.length > 0) onImportFiles?.(files, currentPath)
    },
  }

  /** Answer the open collision and carry on where the operation left off. */
  function answerConflict(policy: 'suffix' | 'replace'): void {
    if (!conflict) return
    setConflict(null)
    if (conflict.kind === 'rename') {
      runRename(conflict.path, conflict.newName, policy)
      return
    }
    if (conflict.kind === 'move') {
      runMove(conflict.paths, conflict.destDir, policy)
      return
    }
  }
}

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/** How a destination directory reads in a toast — its name, or the root. */
function destName(destDir: string): string {
  return destDir ? `“${nameOf(destDir)}”` : 'the library root'
}

function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  return 'That could not be done.'
}
