import type { FileBrowserEntry, FileRead } from '../api/client'
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
   * The single selected bundle's playback-cursor path — the same file its card's
   * own Open/Reveal entries use, so the shortcuts and the menus agree on what
   * "this bundle's file" means. Null when several are selected, or none is.
   */
  selectedBundlePath: string | null
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
