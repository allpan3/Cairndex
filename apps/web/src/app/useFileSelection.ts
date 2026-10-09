import { useEffect, useMemo, useRef, type SetStateAction } from 'react'
import type { FileBrowserEntry } from '../api/client'
import { useSessionState } from '../state/useSessionState'

type Selection = { ids: Set<string>; anchor: string | null; focus: string | null }
const EMPTY: Selection = { ids: new Set(), anchor: null, focus: null }

// Indexed files retain identity across renamed paths; directories and unindexed files use paths
export function fileEntryKey(entry: FileBrowserEntry): string {
  return entry.kind === 'file' && entry.file_id
    ? `file:${entry.file_id}`
    : `${entry.kind}:${entry.relative_path}`
}

// Resolve selection to current paths and prune only after a complete successful directory read
export function useFileSelection(
  key: string,
  entries: FileBrowserEntry[],
  complete: boolean,
  requestedPath: string | null = null,
) {
  const [state, setState] = useSessionState(key, EMPTY)
  const requestSeen = useRef<{ key: string; path: string | null } | null>(null)
  const byId = useMemo(
    () => new Map(entries.map((entry) => [fileEntryKey(entry), entry])),
    [entries],
  )
  const byPath = useMemo(
    () => new Map(entries.map((entry) => [entry.relative_path, fileEntryKey(entry)])),
    [entries],
  )
  const pathFor = (id: string | null) => (id ? (byId.get(id)?.relative_path ?? null) : null)
  const selected = new Set([...state.ids].flatMap((id) => byId.get(id)?.relative_path ?? []))
  const anchor = pathFor(state.anchor)
  const focusedPath = pathFor(state.focus)
  const setSelected = (update: SetStateAction<Set<string>>) => {
    const paths = typeof update === 'function' ? update(selected) : update
    setState((previous) => ({
      ...previous,
      ids: new Set([...paths].flatMap((path) => byPath.get(path) ?? [])),
    }))
  }
  const setAnchor = (path: string | null) =>
    setState((previous) => ({ ...previous, anchor: path ? (byPath.get(path) ?? null) : null }))
  const setFocusedPath = (path: string | null) =>
    setState((previous) => ({ ...previous, focus: path ? (byPath.get(path) ?? null) : null }))
  // Locate requests seed identity once, without reviving a pruned or toggled-off selection
  useEffect(() => {
    if (requestSeen.current?.key === key && requestSeen.current.path === requestedPath) return
    const id = requestedPath ? byPath.get(requestedPath) : null
    if (requestedPath && !id) return
    requestSeen.current = { key, path: requestedPath }
    if (id)
      setState((previous) =>
        previous.focus === id ? previous : { ids: new Set([id]), anchor: id, focus: id },
      )
  }, [key, requestedPath, byPath, setState])
  useEffect(() => {
    if (!complete) return
    setState((previous) => {
      const ids = new Set([...previous.ids].filter((id) => byId.has(id)))
      const anchor = previous.anchor && byId.has(previous.anchor) ? previous.anchor : null
      const focus = previous.focus && byId.has(previous.focus) ? previous.focus : null
      return ids.size === previous.ids.size &&
        anchor === previous.anchor &&
        focus === previous.focus
        ? previous
        : { ids, anchor, focus }
    })
  }, [byId, complete, setState])
  const selectedEntry = state.ids.size === 1 ? (byId.get([...state.ids][0]!) ?? null) : null
  return { selected, setSelected, anchor, setAnchor, focusedPath, setFocusedPath, selectedEntry }
}
