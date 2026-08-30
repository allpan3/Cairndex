/**
 * The right-click menu for a file inside a bundle.
 *
 * One definition, used by both surfaces that show a bundle's files — the album
 * grid and the inspector's file list. They had grown separate menus offering
 * different things for the same file, which is exactly the drift the owner
 * asked to stop (2026-07-27).
 */

import type { FileRead } from '../api/client'
import { contactSheetMenuItem, type ContactSheetTarget } from './contactSheetExport'
import { factsFromBundleFile } from './fileFacts'
import { hostFileMenuEntries } from './hostActions'
import type { HostLabels } from '../platform'
import type { MenuEntry } from './useContextMenu'

export interface BundleFileMenuOptions {
  /** The files acted on: the whole selection, or just the clicked row. */
  targets: FileRead[]
  /** Open/Reveal labels for this host; omit where those actions aren't wired. */
  hostLabels?: HostLabels
  onOpenFile?: (relativePath: string) => void
  onRevealFile?: (relativePath: string) => void
  /** Jump to this file's directory in the File Browser. */
  onLocateFile?: (relativePath: string) => void
  /** Detach from the bundle (metadata only); undefined hides the row. */
  onRemoveFromBundle?: (files: FileRead[]) => void
  /**
   * Drop the rows of files that are gone from disk; undefined hides the row.
   * Offered *instead of* Remove from Bundle when every target is missing —
   * detaching a dead file drops it too, so two rows would do one thing under
   * two names, and only one of the names is honest about it.
   */
  onForgetMissing?: (files: FileRead[]) => void
  /** Move to trash; undefined hides the row (no write mode). */
  onTrash?: (files: FileRead[]) => void
  /**
   * Collapse the targets' shared directory into a single bundle row (plan 6);
   * undefined hides the row. Offered only when every target sits in the *same*
   * directory and that directory is not the library root — a selection spanning
   * two folders has no one folder to collapse, and collapsing the root would
   * swallow the whole bundle into one row.
   */
  onCollapseIntoFolder?: (directoryPath: string) => void
  /** Open the contact-sheet dialog; undefined hides the row. */
  onContactSheet?: (target: ContactSheetTarget) => void
}

/** Everything a contact sheet wants to print about one file.
 *
 * Reads the normalized facts rather than digging into `tech_metadata` again —
 * that dig existed twice, in two shapes, for the same fields.
 */
function contactSheetTargetFor(file: FileRead): ContactSheetTarget {
  const facts = factsFromBundleFile(file)
  return {
    fileId: file.id,
    title: file.display_title,
    sizeBytes: facts.sizeBytes,
    duration: facts.duration,
    width: facts.width,
    height: facts.height,
    fps: facts.fps,
    mimeType: facts.mimeType,
    videoCodec: facts.videoCodec,
    audioCodec: facts.audioCodec,
    videoBitrate: facts.videoBitrate,
    audioBitrate: facts.audioBitrate,
    audioSampleRate: facts.audioSampleRate,
  }
}

/** The one directory every target sits in, or null if they differ or it is the
 *  library root (a root-level file has no parent segment). */
function sharedParentDirectory(targets: FileRead[]): string | null {
  const directories = new Set(
    targets.map((file) => {
      // `lastIndexOf` returns -1 for a root-level file, and `slice(0, -1)` would
      // quietly drop its last character rather than yield the empty parent —
      // offering to collapse a folder named after a truncated filename.
      const cut = file.relative_path.lastIndexOf('/')
      return cut === -1 ? '' : file.relative_path.slice(0, cut)
    }),
  )
  if (directories.size !== 1) return null
  const [only] = [...directories]
  return only ? only : null
}

export function bundleFileMenuEntries(options: BundleFileMenuOptions): MenuEntry[] {
  const { targets, onRemoveFromBundle, onTrash, onContactSheet } = options
  const first = targets[0]
  if (!first) return []
  const n = targets.length

  const items: MenuEntry[] = options.hostLabels
    ? hostFileMenuEntries(
        options.hostLabels,
        { onOpenFile: options.onOpenFile, onRevealFile: options.onRevealFile },
        first.relative_path,
      )
    : []

  if (onTrash) {
    if (items.length > 0) items.push(null)
    items.push({
      // The guarded deletion, same gate and same trash-first shape as the File
      // Browser's: recoverable until the trash is emptied.
      label: n > 1 ? `Move ${n} Files to Trash` : 'Move to Trash',
      danger: true,
      onClick: () => onTrash(targets),
    })
  }

  const bundleItems: MenuEntry[] = []
  // A file that is no longer on disk cannot be detached into the Unbundled
  // pending zone — that zone is for files awaiting registration — so for those
  // the row says what actually happens: the record goes.
  const allMissing = targets.every((file) => file.availability === 'missing')
  const onForget = allMissing ? options.onForgetMissing : undefined
  if (onForget) {
    bundleItems.push({
      label: n > 1 ? `Forget ${n} Missing Files` : 'Forget Missing File',
      onClick: () => onForget(targets),
    })
  } else if (onRemoveFromBundle) {
    bundleItems.push({
      // Metadata-only: the file falls back into Unbundled as its own provisional
      // bundle, exactly as deleting the whole bundle would have staged it.
      label: n > 1 ? `Remove ${n} Files from Bundle` : 'Remove from Bundle',
      onClick: () => onRemoveFromBundle(targets),
    })
  }
  const sharedDirectory = sharedParentDirectory(targets)
  if (options.onCollapseIntoFolder && sharedDirectory) {
    bundleItems.push({
      // Metadata-only and reversible from the folder row it creates: the files
      // stay members of the bundle and are only drawn as one row.
      label: `Collapse \u201C${sharedDirectory.split('/').pop()}\u201D into One Row`,
      onClick: () => options.onCollapseIntoFolder?.(sharedDirectory),
    })
  }
  if (options.onLocateFile && n === 1) {
    bundleItems.push({
      label: 'Locate in File Browser',
      onClick: () => options.onLocateFile?.(first.relative_path),
    })
  }
  if (bundleItems.length > 0) {
    if (items.length > 0) items.push(null)
    items.push(...bundleItems)
  }

  // Only for a single video: a sheet is built from one file, and the dialog
  // asks about that file's duration.
  if (onContactSheet && n === 1 && first.media_kind === 'video') {
    if (items.length > 0) items.push(null)
    items.push(contactSheetMenuItem(contactSheetTargetFor(first), onContactSheet))
  }

  return items
}
