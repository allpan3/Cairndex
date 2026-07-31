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
  /** Move to trash; undefined hides the row (no write mode). */
  onTrash?: (files: FileRead[]) => void
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
  if (onRemoveFromBundle) {
    bundleItems.push({
      // Metadata-only: the file falls back into Unbundled as its own provisional
      // bundle, exactly as deleting the whole bundle would have staged it.
      label: n > 1 ? `Remove ${n} Files from Bundle` : 'Remove from Bundle',
      onClick: () => onRemoveFromBundle(targets),
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
