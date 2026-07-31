import { createContext, useContext, useMemo } from 'react'

import type { HostLabels } from '../platform'

/**
 * Everything the Bundle Inspector can do beyond editing the bundle in front of
 * it: open the viewer, reach the host filesystem, jump the shell somewhere, or
 * report back to it.
 *
 * **One object, read from context — deliberately not a prop list.** The
 * inspector is rendered on two surfaces (the shell's right-hand rail and the
 * rail the media viewer docks beside a playing file) and they were separate
 * call sites passing separate prop lists. The viewer's passed `bundleId` and
 * nothing else, so every action gated on one of these handlers was quietly
 * absent there — a shorter right-click menu, and tag edits that completed with
 * no confirmation because there was nothing to report them to (owner,
 * 2026-07-30). Nothing about two `<Inspector …/>` call sites made that
 * visible, and a prop added to one would go missing from the other again.
 *
 * Context makes the parity structural instead of remembered: a handler added
 * to this interface is supplied once, by the shell, and reaches every surface
 * at once. A surface that genuinely needs different behaviour overrides just
 * those entries (see `useMergedBundleInspectorActions`) rather than restating
 * the whole set.
 */
export interface BundleInspectorActions {
  /** Open/Reveal wording for this host; omitted where those are not wired. */
  hostLabels?: HostLabels
  /** Open the "Add files" manual bundling dialog for this bundle. */
  onAddFiles?: (bundleId: string) => void
  /** Open the unified media viewer for this bundle. */
  onPlayBundle?: (bundleId: string) => void
  /** Open one supported file directly in the unified media viewer. */
  onPlayFile?: (bundleId: string, fileId: string) => void
  /** Open this file with the OS default app (mapped desktop library only). */
  onOpenFile?: (relativePath: string) => void
  /** Reveal this file in Finder (mapped desktop library only). */
  onRevealFile?: (relativePath: string) => void
  /** Jump to this file's directory in the File Browser. */
  onLocateFile?: (relativePath: string) => void
  /** Move files to the library trash (present only while write mode is on). */
  onTrashFiles?: (relativePaths: string[]) => void
  /** Drag this bundle's files out to Finder/other apps (plan 3 §6). */
  onStartFileDrag?: (relativePaths: string[]) => void
  /** Report a transient message (export progress, results) to the surface. */
  onFlash?: (message: string) => void
  /** Filter the library by these tags, from a tag pill's menu. */
  onFilterByTags?: (tagIds: string[]) => void
  /** Navigate the shell to one collection from its inspector pill. */
  onOpenCollection?: (collectionId: string) => void
}

/** Every key of `BundleInspectorActions`, as data.
 *
 * Exported so a test can assert that both surfaces offer the same set without
 * restating the list a third time — restating it is the bug this file exists
 * to prevent. `satisfies` keeps it honest: an action added above and not added
 * here fails to compile. */
export const BUNDLE_INSPECTOR_ACTION_KEYS = [
  'hostLabels',
  'onAddFiles',
  'onPlayBundle',
  'onPlayFile',
  'onOpenFile',
  'onRevealFile',
  'onLocateFile',
  'onTrashFiles',
  'onStartFileDrag',
  'onFlash',
  'onFilterByTags',
  'onOpenCollection',
] as const satisfies readonly (keyof BundleInspectorActions)[]

/**
 * Provide with `<BundleInspectorActionsContext value={…}>`.
 *
 * Empty by default rather than undefined: an inspector rendered outside any
 * provider (a focused component test, say) degrades to "no extra actions"
 * instead of throwing, which is what the optional props used to mean.
 */
export const BundleInspectorActionsContext = createContext<BundleInspectorActions>({})

/** The actions in scope for this inspector. */
export function useBundleInspectorActions(): BundleInspectorActions {
  return useContext(BundleInspectorActionsContext)
}

/**
 * The surrounding actions with a few entries replaced, for a surface whose
 * context changes what an action *means* — inside the viewer, "play this file"
 * is a step within the open playlist rather than a second viewer on top of the
 * first — without it having to know, or restate, the actions it is not
 * changing.
 */
export function useMergedBundleInspectorActions(
  overrides: BundleInspectorActions,
): BundleInspectorActions {
  const inherited = useBundleInspectorActions()
  return useMemo(() => ({ ...inherited, ...overrides }), [inherited, overrides])
}
