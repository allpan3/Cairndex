import { useCallback, useSyncExternalStore } from 'react'

/**
 * How this client marks the copies it writes out.
 *
 * Separate from `displayPrefs`, which is about how the library is *looked at*:
 * nothing here changes a pixel on screen, only what lands in an exported file.
 * Kept client-local for the same reason the export folder is (Settings →
 * Exports) — it is a property of the machine doing the exporting, not of the
 * library, and it needs no server round trip to answer.
 *
 * A **shared store** rather than `usePersistentState`, matching `displayPrefs`:
 * the Settings dialog writes it while an open viewer reads it, and per-component
 * state would leave a snapshot taken straight after the change still carrying
 * the old mark.
 */
/** Whether the mark is words or a picture. One or the other, never both. */
export type WatermarkKind = 'text' | 'image'

export interface ExportPrefs {
  /** Whether exports carry a watermark at all. */
  watermarkEnabled: boolean
  /** Which of the two marks below is used. */
  watermarkKind: WatermarkKind
  /** The text drawn as the mark, when the kind is `text`. */
  watermarkText: string
  /**
   * The chosen image as a `data:` URL, or null if none has been picked.
   *
   * Inlined rather than referenced by path: a browser never gets a usable path
   * from a file picker, and a copy under the data dir would be a server round
   * trip for something only this machine needs. Bounded on import
   * (`watermarkImage.ts`) so one logo cannot exhaust the storage quota.
   */
  watermarkImage: string | null
  /** The chosen file's name, so Settings can say which image is in use. */
  watermarkImageName: string | null
}

/**
 * Off, because a watermark is branding rather than a default courtesy: these
 * are the owner's own files, and every export before this setting existed was
 * unmarked apart from the contact sheet's hardcoded block, which this replaces.
 * The text is seeded anyway so enabling the toggle produces something at once —
 * which is also why `text` is the starting kind: an image needs a file chosen
 * before it can mark anything, so starting there would show an empty setting.
 */
export const DEFAULT_EXPORT_PREFS: ExportPrefs = {
  watermarkEnabled: false,
  watermarkKind: 'text',
  watermarkText: 'CAIRNDEX',
  watermarkImage: null,
  watermarkImageName: null,
}

/** Longer than this stops being a mark and starts being a caption. */
export const MAX_WATERMARK_TEXT_LENGTH = 64

const STORAGE_KEY = 'cairndex.exportPrefs'

function read(): ExportPrefs {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_EXPORT_PREFS
    // Merged over the defaults so a value stored before a newer field existed
    // does not read back as undefined.
    return { ...DEFAULT_EXPORT_PREFS, ...(JSON.parse(raw) as Partial<ExportPrefs>) }
  } catch {
    return DEFAULT_EXPORT_PREFS
  }
}

// One snapshot object per change, cached so `useSyncExternalStore` sees a stable
// reference between renders (a fresh object each call would loop forever).
let snapshot: ExportPrefs = read()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function write(next: ExportPrefs): void {
  snapshot = next
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* private mode / quota — the preference still applies for this session */
  }
  for (const listener of listeners) listener()
}

/** Read the preferences, re-rendering every reader when any of them changes. */
export function useExportPrefs(): [ExportPrefs, (update: Partial<ExportPrefs>) => void] {
  const prefs = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
  const set = useCallback((update: Partial<ExportPrefs>) => write({ ...snapshot, ...update }), [])
  return [prefs, set]
}

/**
 * The current preferences outside React.
 *
 * The export paths are plain functions called from menu handlers, not hooks, so
 * they read the store directly rather than having the mark threaded down to
 * them through every surface that can start an export.
 */
export function getExportPrefs(): ExportPrefs {
  return snapshot
}

/**
 * Test seam: a clean slate — no subscribers, no stored value, no snapshot.
 *
 * Clearing storage is the point. Leaving it behind made "reset" a lie in any
 * environment that actually has `localStorage`: the snapshot went back to the
 * defaults while the stored value stayed, so the next read resurrected it and
 * one test's preferences leaked into the next.
 */
export function resetExportPrefsForTests(): void {
  listeners.clear()
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY)
  } catch {
    /* nothing stored, nothing to clear */
  }
  snapshot = DEFAULT_EXPORT_PREFS
}

/** Test seam: re-read storage without clearing it, modelling a fresh load. */
export function reloadExportPrefsForTests(): void {
  listeners.clear()
  snapshot = read()
}
