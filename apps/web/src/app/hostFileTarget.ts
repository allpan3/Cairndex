import type { BundleSummary, FileBrowserEntry, FileRead } from '../api/client'
import type { AppMode } from './types'

/** What the host-file actions would act on, and why they cannot when they
 *  cannot. Shared by Open in Default App and Reveal in Finder: they take the
 *  same selection and differ only in what the OS then does with it. */
export type HostFileTarget =
  | { kind: 'file'; relativePath: string }
  | { kind: 'none'; reason: 'no-selection' | 'directory' }

export interface HostFileTargetContext {
  /** Which surface is on screen — it decides whose selection counts. */
  mode: AppMode
  /** The File Browser's selected entry, file or directory. */
  fileEntry: FileBrowserEntry | null
  /** The one file selected inside an open bundle, when the album view has one. */
  albumFile: FileRead | null
  /**
   * The single selected bundle's file on disk, from `bundleHostPath` — the same
   * file its card's own Open/Reveal entries use, so the shortcuts and the menus
   * agree on what "this bundle's file" means. Null when several are selected, or
   * none is.
   */
  selectedBundlePath: string | null
}

/**
 * The file a bundle hands to the OS, read from its card summary.
 *
 * Deliberately **not** `resume_relative_path`. That field is the web viewer's:
 * the server fills it only for a file the viewer can stage, which makes it null
 * for exactly the two cases where handing the file to another application
 * matters most — a present file in a format Cairndex cannot show, and a file
 * that has gone missing. Reading it here dropped Open and Reveal from the card
 * menu with no trace, so an unsupported format looked like a missing feature and
 * the whole Missing Files view had neither entry (owner, 2026-08-24).
 *
 * Availability is not tested here either. Whether the file is really on disk is
 * the filesystem's answer at the moment of the attempt, and the shell gives it:
 * a path that is not there comes back as `path_not_found`, an unmounted volume
 * as `volume_not_mounted`, each with its own copy. The library's own `missing`
 * flag is a snapshot from the last scan, so refusing on it would block a file
 * that has since come back.
 */
export function bundleHostPath(
  bundle: Pick<BundleSummary, 'primary_relative_path'> | undefined,
): string | null {
  return bundle?.primary_relative_path ?? null
}

/**
 * Resolve the file the host-file shortcuts should act on.
 *
 * Keyed on the visible surface rather than on a blind priority chain: a stale
 * selection in a pane you are *not* looking at should never be what opens in
 * Finder, and All Tags — which shows no files at all — resolves to nothing.
 * Inside the Bundle Browser a selected file wins over the bundle around it,
 * because when the album view has one, the inspector is already describing that
 * file rather than the bundle.
 *
 * The viewer is deliberately not a source. Its current file lives in its own
 * state, and an accelerator is handled by the OS before the webview sees it, so
 * routing one there would mean publishing the viewer's position upward for a
 * case the context menus already cover.
 */
export function hostFileTargetFor(context: HostFileTargetContext): HostFileTarget {
  const { mode, fileEntry, albumFile, selectedBundlePath } = context

  if (mode === 'file') {
    if (!fileEntry) return { kind: 'none', reason: 'no-selection' }
    // A folder is a legitimate thing to have selected and not a thing this
    // reveals, so it gets its own reason rather than "nothing selected".
    if (fileEntry.kind !== 'file') return { kind: 'none', reason: 'directory' }
    return { kind: 'file', relativePath: fileEntry.relative_path }
  }

  if (mode === 'collection') {
    if (albumFile) return { kind: 'file', relativePath: albumFile.relative_path }
    if (selectedBundlePath) return { kind: 'file', relativePath: selectedBundlePath }
  }
  // All Tags shows no files, so a bundle selection left over from the Bundle
  // Browser is not "what is selected" — it is off screen.
  return { kind: 'none', reason: 'no-selection' }
}
