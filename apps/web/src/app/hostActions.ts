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
