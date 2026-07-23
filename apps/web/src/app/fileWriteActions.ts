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

/** A rename waiting on the owner's answer to a collision. */
interface PendingRename {
  path: string
  newName: string
  /** The name already in the way, as the server reported it. */
  conflictingName: string
}

/** Files the owner has asked to delete, awaiting confirmation. */
export interface PendingDelete {
  paths: string[]
  /** How many of them are linked into a bundle — the part worth pausing over. */
  linkedCount: number
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
  conflict: PendingRename | null
  keepBoth: () => void
  replace: () => void
  dismissConflict: () => void
  /** The delete confirmation, or null. Render with `<DeleteDialog />`. */
  pendingDelete: PendingDelete | null
  askToDelete: (paths: string[], linkedCount: number) => void
  confirmDelete: () => void
  dismissDelete: () => void
}

export function useFileWriteActions({
  currentPath,
  onFlash,
}: {
  /** The directory being browsed; New Folder is created inside it. */
  currentPath: string
  /** Show a message, with an Undo action when the operation has an inverse. */
  onFlash: (message: string, undo?: () => void) => void
}): FileWriteActions {
  const { rename, mkdir, undo, trash } = useFileOperations()
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [creatingFolder, setCreatingFolder] = useState(false)
  const [conflict, setConflict] = useState<PendingRename | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)

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
            setConflict({ path, newName, conflictingName: failure.entryName || newName })
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
    busy: rename.isPending || mkdir.isPending || undo.isPending || trash.isPending,
    conflict,
    keepBoth: () => {
      if (conflict) runRename(conflict.path, conflict.newName, 'suffix')
    },
    replace: () => {
      if (conflict) runRename(conflict.path, conflict.newName, 'replace')
    },
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
          const count = target.paths.length
          onFlash(
            count === 1
              ? `Moved “${nameOf(target.paths[0] as string)}” to the trash.`
              : `Moved ${count} items to the trash.`,
            undoLater(result.operation.id),
          )
        },
        onError: (failure) => onFlash(messageOf(failure)),
      })
    },
    dismissDelete: () => setPendingDelete(null),
  }
}

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

function messageOf(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  return 'That could not be done.'
}
