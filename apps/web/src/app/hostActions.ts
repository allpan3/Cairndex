import type { HostLabels } from '../platform'
import type { MenuEntry } from './useContextMenu'

/** Host handoff callbacks for the active library; undefined hides the action. */
export interface HostFileActions {
  onOpenFile?: (relativePath: string) => void
  onRevealFile?: (relativePath: string) => void
}

/**
 * The Open/Reveal context-menu pair every surface renders identically (open
 * first, then reveal). Returns [] when neither action is available, so call
 * sites can gate their separators on the length.
 *
 * A host that cannot act leaves them out rather than showing them disabled: the
 * owner asked for no such rows in the context menus (2026-08-24), and with the
 * local server's own library path now adopted automatically, the case they
 * explained — a library this Mac serves but has not been told about — no longer
 * arises. Where the pair genuinely cannot work, `File ▸ Reveal in Finder` in the
 * menu bar is what says so.
 */
export function hostFileMenuEntries(
  labels: HostLabels,
  { onOpenFile, onRevealFile }: HostFileActions,
  relativePath: string,
): MenuEntry[] {
  const entries: MenuEntry[] = []
  if (onOpenFile) entries.push({ label: labels.openFile, onClick: () => onOpenFile(relativePath) })
  if (onRevealFile)
    entries.push({ label: labels.revealFile, onClick: () => onRevealFile(relativePath) })
  return entries
}
