import { useCallback, useSyncExternalStore } from 'react'

/**
 * Display preferences that belong to this client, not to the library.
 *
 * Deliberately separate from `cairndex.filePrefs` (layout/sort/zoom, which the
 * File Browser owns and changes from its own toolbar): these are answers the
 * owner gives once in Settings and expects every surface to respect. Stored
 * locally because "how I like to look at my library" travels with the machine,
 * not with the metadata.
 *
 * A **shared store** rather than `usePersistentState`, because two components
 * read this at once: the Settings dialog that writes it and the File Browser
 * behind it. Per-component state would leave the browser showing the old answer
 * until it happened to remount — the setting would look like it had not applied.
 */
export interface DisplayPrefs {
  /** Show `Holiday` rather than `Holiday.mkv` in file listings. */
  hideFileExtensions: boolean
}

export const DEFAULT_DISPLAY_PREFS: DisplayPrefs = { hideFileExtensions: false }

const STORAGE_KEY = 'cairndex.displayPrefs'

function read(): DisplayPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_DISPLAY_PREFS
    // Merged over the defaults so a value stored before a newer field existed
    // does not read back as undefined.
    return { ...DEFAULT_DISPLAY_PREFS, ...(JSON.parse(raw) as Partial<DisplayPrefs>) }
  } catch {
    return DEFAULT_DISPLAY_PREFS
  }
}

// One snapshot object per change, cached so `useSyncExternalStore` sees a stable
// reference between renders (a fresh object each call would loop forever).
let snapshot: DisplayPrefs = read()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function write(next: DisplayPrefs): void {
  snapshot = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* private mode / quota — the preference still applies for this session */
  }
  for (const listener of listeners) listener()
}

/** Read the preferences, re-rendering every reader when any of them changes. */
export function useDisplayPrefs(): [DisplayPrefs, (update: Partial<DisplayPrefs>) => void] {
  const prefs = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
  const set = useCallback((update: Partial<DisplayPrefs>) => write({ ...snapshot, ...update }), [])
  return [prefs, set]
}

/** Test seam: forget everything so one case cannot leak into the next. */
export function resetDisplayPrefsForTests(): void {
  snapshot = DEFAULT_DISPLAY_PREFS
  listeners.clear()
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
