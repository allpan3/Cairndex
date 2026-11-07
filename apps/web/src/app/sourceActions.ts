import { operationId } from '../api/catalog'
import type { ReceiptPage, SourceReceipt } from '../api/sourceOperations'
import { folderLabel, joinPath, parentFolder } from './sourceTasks'
import type { NewTask } from './useSourceTasks'

export const leaf = (path: string) => path.split('/').at(-1) ?? path
const items = (count: number) => (count === 1 ? '1 item' : `${count.toLocaleString()} items`)
/** “name” for one item, “3 items” for more. */
export const what = (paths: string[]) =>
  paths.length === 1 ? `“${leaf(paths[0]!)}”` : items(paths.length)

/** Library items copied or moved into one folder: a task of one operation per item. */
export function relocationTask(action: 'copy' | 'move', paths: string[], folder: string): NewTask {
  const verb = action === 'copy' ? 'Copying' : 'Moving'
  const done = action === 'copy' ? 'Copied' : 'Moved'
  return {
    title: `${verb} ${what(paths)} to ${folderLabel(folder)}`,
    summary: `${done} ${what(paths)} to ${folderLabel(folder)}.`,
    finish: { kind: 'none' },
    items: paths.map((path) => ({
      name: leaf(path),
      size: null,
      request: {
        operation: operationId(),
        action,
        source: path,
        destination: joinPath(folder, leaf(path)),
        collision: 'fail',
      },
    })),
  }
}

/** Library items moved to the library's Trash, where Put Back can restore them. */
export function trashTask(paths: string[]): NewTask {
  return {
    title: `Moving ${what(paths)} to the Trash`,
    summary: `Moved ${what(paths)} to the Trash.`,
    finish: { kind: 'none' },
    items: paths.map((path) => ({
      name: leaf(path),
      size: null,
      request: { operation: operationId(), action: 'trash', source: path, destination: '' },
    })),
  }
}

/** Why a new name cannot be used, or `null` when it can. */
export function renameError(name: string): string | null {
  if (name === '.' || name === '..' || /[/\\]/.test(name) || name.includes('\0'))
    return 'Enter a name without folder separators.'
  return null
}

/** A new name for one item, in place. */
export function renameTask(path: string, name: string): NewTask {
  return {
    title: `Renaming “${leaf(path)}”`,
    summary: `Renamed “${leaf(path)}” to “${name}”.`,
    finish: { kind: 'none' },
    items: [
      {
        name: leaf(path),
        size: null,
        request: {
          operation: operationId(),
          action: 'rename',
          source: path,
          destination: joinPath(parentFolder(path), name),
          collision: 'fail',
        },
      },
    ],
  }
}

export type TrashRow =
  | { kind: 'trashed'; id: string; pending: boolean; receipt: SourceReceipt }
  | {
      kind: 'replaced'
      id: string
      pending: boolean
      path: string
      version: 'source' | 'destination'
      size: number
    }

/**
 * Receipts as the Trash lists them: trashed items not yet put back, and the
 * versions a Replace kept. A receipt whose metadata is still on its way lists
 * as pending: undo checks that metadata, so it waits for it.
 */
export function trashRows(pages: ReceiptPage[]): TrashRow[] {
  const all = pages.flatMap((page) => page.items)
  const undone = new Set(
    all.flatMap((item) => [item.receipt?.undo_of, item.receipt?.purges]).filter(Boolean),
  )
  return all.flatMap((item): TrashRow[] => {
    const receipt = item.receipt
    if (!receipt || undone.has(item.id) || receipt.undo_of) return []
    const pending = item.state === 'pending'
    if (receipt.action === 'trash' || receipt.action === 'retain')
      return [{ kind: 'trashed', id: item.id, pending, receipt }]
    return Object.entries(receipt.versions_before).flatMap(([path, version]) =>
      version && version.version !== 'original' && path === receipt.destination
        ? [
            {
              kind: 'replaced' as const,
              id: item.id,
              pending,
              path,
              version: version.version,
              size: version.evidence.size,
            },
          ]
        : [],
    )
  })
}

/** Put Back for a trashed item, Restore a Copy for a replaced version. */
export function trashRowTask(row: TrashRow): NewTask {
  if (row.kind === 'trashed') {
    const path = row.receipt.source
    return {
      title: `Putting back “${leaf(path)}”`,
      summary: `Put back “${leaf(path)}” in ${folderLabel(parentFolder(path))}.`,
      undoable: false,
      finish: { kind: 'none' },
      items: [
        {
          name: leaf(path),
          size: null,
          request: {
            operation: operationId(),
            action: row.receipt.action === 'retain' ? 'return' : 'undo',
            prior: row.id,
          },
        },
      ],
    }
  }
  // Beside the file that replaced it, under a new name; nothing is overwritten
  return {
    title: `Restoring a copy of “${leaf(row.path)}”`,
    summary: `Restored a copy of “${leaf(row.path)}” in ${folderLabel(parentFolder(row.path))}.`,
    finish: { kind: 'none' },
    items: [
      {
        name: leaf(row.path),
        size: row.size,
        request: {
          operation: operationId(),
          action: 'restore',
          prior: row.id,
          version: row.version,
          destination: row.path,
          collision: 'suffix',
        },
      },
    ],
  }
}

/** Keep invalid folder names editable before starting a source operation. */
export function newFolderError(name: string): string | null {
  if (!name) return 'Enter a folder name.'
  return (
    renameError(name) ??
    (name.startsWith('.') || name.endsWith('.')
      ? 'A folder name cannot start or end with a dot.'
      : null)
  )
}

/** Create only a vacant folder; an occupied name is never replaced. */
export function newFolderTask(folder: string, name: string): NewTask {
  return {
    title: `Creating “${name}”`,
    summary: `Created folder “${name}”.`,
    finish: { kind: 'none' },
    items: [
      {
        name,
        size: null,
        request: {
          operation: operationId(),
          action: 'mkdir',
          destination: joinPath(folder, name),
        },
      },
    ],
  }
}

/** Only new retained originals are eligible; historical recovery copies remain intact. */
export function purgeTask(rows: TrashRow[]): NewTask {
  return {
    title: `Emptying Trash (${items(rows.length)})`,
    summary: `Permanently deleted ${items(rows.length)}.`,
    undoable: false,
    finish: { kind: 'none' },
    items: rows.flatMap((row) =>
      row.kind === 'trashed' && row.receipt.action === 'retain'
        ? [
            {
              name: leaf(row.receipt.source),
              size: null,
              request: { operation: operationId(), action: 'purge' as const, prior: row.id },
            },
          ]
        : [],
    ),
  }
}
