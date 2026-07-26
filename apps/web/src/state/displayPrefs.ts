import { usePersistentState } from './usePersistentState'

/**
 * Display preferences that belong to this client, not to the library.
 *
 * Deliberately separate from `cairndex.filePrefs` (layout/sort/zoom, which the
 * File Browser owns and changes from its own toolbar): these are answers the
 * owner gives once in Settings and expects every surface to respect. Stored
 * locally because "how I like to look at my library" travels with the machine,
 * not with the metadata.
 */
export interface DisplayPrefs {
  /** Show `Holiday` rather than `Holiday.mkv` in file listings. */
  hideFileExtensions: boolean
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { hideFileExtensions: false }

const STORAGE_KEY = 'cairndex.displayPrefs'

export function useDisplayPrefs() {
  return usePersistentState<DisplayPrefs>(STORAGE_KEY, DEFAULT_DISPLAY_PREFS)
}

/**
 * A file's name as it should be shown, given the preference.
 *
 * Only the *displayed* label changes — never the path an operation is sent, and
 * never what search matches, so hiding extensions cannot alter behaviour. A
 * directory keeps its whole name (a folder called `Season 1.5` has no extension
 * to hide), and so does a dotfile-shaped name with nothing before the dot.
 */
export function displayName(name: string, isDirectory: boolean, hide: boolean): string {
  if (!hide || isDirectory) return name
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}
