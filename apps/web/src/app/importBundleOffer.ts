/**
 * What an import says for itself, and the bundle it offers to join.
 *
 * A file added through the File Browser lands in the folder on screen and joins
 * nothing — it is in the library but invisible to the Bundle Browser until the
 * next scan stages it. Closing that gap is what this is for (owner, 2026-08-25):
 * the destination folder is the strongest signal about which bundle a file
 * belongs to, so the toast reporting the import can carry the answer.
 *
 * An *offer*, never an action. The file has already landed where it was told to,
 * Undo still reverses that, and anything this declines to guess at is still one
 * right-click away under Add to Bundle….
 *
 * Kept out of the component so the decisions here — which suggestion is worth
 * offering unasked, and what the message says — are testable without rendering
 * the app around them.
 */
import type { TargetSuggestion } from '../api/client'

/**
 * How sure a suggestion must be before an import offers it unprompted.
 *
 * The suggester returns anything with a signal at all, which is right for a
 * dialog opened to compare candidates and wrong for a toast that appears on its
 * own: a 10%-confident guess in the corner of the screen is noise that teaches
 * you to ignore the corner. This is the boundary the bundling dialogs' own
 * confidence pill calls "medium".
 */
export const OFFER_BUNDLE_ABOVE = 0.4

/**
 * How far ahead of the runner-up the leader must be to be offered unprompted.
 *
 * One folder can hold several bundles, so a destination path often cannot say
 * *which* — two bundles in the same folder score identically, and the order
 * between them then comes down to their titles. Naming one of those in a toast
 * would present a coin flip as a recommendation, so an unprompted offer is made
 * only when the path actually distinguishes a winner; otherwise the toast stays
 * quiet and Add to Bundle… lists them all.
 *
 * 0.05 separates cleanly: an exact tie is 0 apart, while the weakest
 * distinguishing signal the suggester can add (a single shared name token) is
 * 0.1. It is also comfortably clear of float noise — the API rounds confidences
 * to three places, and 0.6 − 0.5 does not equal 0.1 in binary floating point.
 */
export const OFFER_MARGIN = 0.05

/** A button the import toast can carry beside its message. */
export interface ToastOffer {
  label: string
  run: () => void
}

/** One file that actually made it onto disk, with the operation that put it there. */
export interface LandedFile {
  path: string
  operationId: string
}

export interface ImportOfferDeps {
  /** Ranked bundles for the paths that landed. */
  suggest: (relativePaths: string[]) => Promise<TargetSuggestion[]>
  /** Link the landed paths into a bundle (metadata-only). */
  addToBundle: (bundleId: string, relativePaths: string[]) => Promise<unknown>
  /** Reverse one import operation (ADR-0013 §3.1). */
  undoOperation: (operationId: string) => void
  /**
   * Open Add to Bundle… for these paths — the fallback when this cannot name a
   * winner, and the reason the toast is never silent.
   */
  openPicker: (relativePaths: string[]) => void
  /**
   * Open Create Bundle… for these paths.
   *
   * Always offered beside the add-to action, because a file arriving in the
   * library is at least as likely to *be* a new bundle as to join one, and the
   * suggester can only ever propose the second (owner, 2026-08-26).
   */
  openCreate: (relativePaths: string[]) => void
  /** Show the result, optionally with an Undo and any number of offers. */
  show: (message: string, undo?: () => void, offers?: ToastOffer[]) => void
  /** Refresh caches after a successful link. */
  onLinked?: (bundleId: string) => void
}

/** How a destination folder reads in a message — its own name, or the root. */
function whereIn(destDir: string): string {
  return destDir ? (destDir.split('/').pop() as string) : 'the library root'
}

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/** What the import reports: only what landed, and where it went. */
export function importedSummary(landed: LandedFile[], destDir: string): string {
  const where = whereIn(destDir)
  if (landed.length === 1) return `Added “${nameOf((landed[0] as LandedFile).path)}” to ${where}.`
  return `Added ${landed.length} files to ${where}.`
}

/**
 * The single suggestion an unprompted offer should carry — confident enough to
 * be worth naming, and clearly ahead of the next one so it is not a guess
 * between equals. `ranked` is assumed ordered by descending confidence, as the
 * endpoint returns it.
 */
export function offerableBundle(ranked: TargetSuggestion[]): TargetSuggestion | null {
  const leader = ranked[0]
  if (!leader || leader.confidence < OFFER_BUNDLE_ABOVE) return null
  const runnerUp = ranked[1]
  if (runnerUp && leader.confidence - runnerUp.confidence < OFFER_MARGIN) return null
  return leader
}

/**
 * Report a finished import, offering the bundle its destination implies.
 *
 * `landed` is deliberately only what reached disk: a skipped collision or a
 * failed upload has no path, and offering to link the name it *would* have had
 * would put a row in a bundle for a file that is not there.
 */
export async function announceImport(
  landed: LandedFile[],
  destDir: string,
  deps: ImportOfferDeps,
): Promise<void> {
  if (landed.length === 0) return
  const paths = landed.map((file) => file.path)
  const message = importedSummary(landed, destDir)
  // Undo the whole batch rather than the one file whose per-file toast this
  // replaces: each import is its own journal operation, so reversing "what just
  // happened" means reversing all of them.
  const undoAll = () => {
    for (const file of landed) deps.undoOperation(file.operationId)
  }

  let best: TargetSuggestion | null = null
  try {
    best = offerableBundle(await deps.suggest(paths))
  } catch {
    // A suggestion is a convenience. Failing to fetch one must not make a
    // successful import read as a failure — it falls through to the picker,
    // which is reachable whether or not this lookup answered.
  }

  // Two things can be done with what just landed, and the suggester can only
  // ever propose one of them: a new file is at least as likely to *be* a bundle
  // as to join one (owner, 2026-08-26). So the toast carries both.
  const offers: ToastOffer[] = []

  if (best === null) {
    // Withholding the *named* offer is a judgement about confidence, not about
    // whether the owner wants to bundle what they added — and a toast that goes
    // quiet is indistinguishable from a feature that is not working. So an
    // unconvincing guess degrades to the full ranked list plus a search over
    // every confirmed bundle, rather than to nothing.
    offers.push({ label: 'Add to Bundle', run: () => deps.openPicker(paths) })
  } else {
    const bundleId = best.bundle_id
    const title = best.title ?? 'that bundle'
    offers.push({
      label: `Add to “${title}”`,
      run: () => {
        void deps
          .addToBundle(bundleId, paths)
          .then(() => {
            deps.onLinked?.(bundleId)
            deps.show(`Added to “${title}”.`)
          })
          .catch((error: unknown) =>
            deps.show(error instanceof Error ? error.message : 'That could not be added.'),
          )
      },
    })
  }

  // No ellipsis on either label, though both open a dialog and the menus spell
  // that with one (Move to…, Rename…). The owner asked for them gone here
  // (2026-08-26), and a toast chip is not a menu row: three of them side by side
  // with trailing dots is visual noise, and nothing on a toast is instantaneous
  // enough for the distinction to be earning its keep.
  offers.push({ label: 'New Bundle', run: () => deps.openCreate(paths) })
  deps.show(message, undoAll, offers)
}
