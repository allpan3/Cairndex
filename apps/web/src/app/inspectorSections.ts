import { useCallback } from 'react'

import { usePersistentState } from '../state/usePersistentState'

/**
 * Which Bundle Inspector sections are folded (owner, 2026-08-30).
 *
 * Its own module because it is state, not a component: keeping it beside
 * `InspectorSection` cost that file its fast refresh, and every section header
 * re-mounting on a style tweak is a poor trade for one fewer file.
 */
const STORAGE_KEY = 'cairndex.inspectorFolded'

export type InspectorSectionId = 'notes' | 'tags' | 'collections' | 'moments' | 'files'

/** Fold state for every section, as `{ [id]: true }` for the folded ones. */
export function useFoldedSections() {
  const [folded, setFolded] = usePersistentState<Partial<Record<InspectorSectionId, boolean>>>(
    STORAGE_KEY,
    {},
  )
  const toggle = useCallback(
    (id: InspectorSectionId) => setFolded((current) => ({ ...current, [id]: !current[id] })),
    [setFolded],
  )
  return { folded, toggle }
}
