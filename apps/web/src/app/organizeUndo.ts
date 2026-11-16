import { createContext, useContext, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import { reverseChanges, type MembershipChange } from '../api/catalogUndo'
import { captureRequestScope } from '../api/requestScope'
import type { CatalogNotice } from './CatalogToast'
import { undoStamp, type Undoable } from './undoShortcut'

/** Records organizing changes so the browser's message and ⌘Z can undo them. */
export interface OrganizeUndo {
  /**
   * Report a finished change. With every change planned and something changed,
   * the message offers Undo and ⌘Z undoes it; otherwise it is a plain message.
   */
  record: (text: string, changes: (MembershipChange | null)[]) => void
}

/** The browser's organizing history, which the shared ⌘Z reads (useUndoShortcut). */
export interface OrganizeUndoStack extends OrganizeUndo {
  /** This library's latest change, or null; another library's are not on screen. */
  newest: () => Undoable | null
}

export const OrganizeUndoContext = createContext<OrganizeUndo | null>(null)

/** The browser's undo recorder, or null where no message can offer one (the viewer). */
export function useOrganizeUndo(): OrganizeUndo | null {
  return useContext(OrganizeUndoContext)
}

// Every view that shows a membership or counts one
const AFFECTED = [
  'catalog-selection',
  'catalog-memberships',
  'catalog-bulk-memberships',
  'catalog-browse',
  'catalog-detail',
  'catalog-navigation',
  'catalog-view-counts',
  'catalog-tag-counts',
]

// Enough to step back through a working session, not a history
const DEPTH = 20

interface Entry {
  at: number
  library: string
  text: string
  changes: MembershipChange[]
}

/** "1 bundle", "3 bundles": how organizing messages count what they changed. */
export function bundleCount(count: number): string {
  return `${count} bundle${count === 1 ? '' : 's'}`
}

/** The message for adding bundles to a tag or collection, or removing them. */
export function membershipText(
  family: 'tags' | 'collections',
  name: string,
  assigned: boolean,
  count: number,
): string {
  const bundles = bundleCount(count)
  if (family === 'tags')
    return assigned ? `Added “${name}” to ${bundles}.` : `Removed “${name}” from ${bundles}.`
  return assigned ? `Added ${bundles} to “${name}”.` : `Removed ${bundles} from “${name}”.`
}

/**
 * The browser's organizing undo stack. Each message's Undo undoes its own
 * change, and `newest` gives the shared ⌘Z the latest one. Undo is itself a
 * guarded change.
 */
export function useOrganizeUndoStack(
  library: string,
  onNotice: (notice: CatalogNotice) => void,
): OrganizeUndoStack {
  const client = useQueryClient()
  const stack = useRef<Entry[]>([])
  const running = useRef(false)
  const notify = useRef(onNotice)
  useEffect(() => {
    notify.current = onNotice
  })
  const undo = useMemo(() => {
    return (entry: Entry) => {
      // One at a time: a second ⌘Z waits for the first rather than losing its change
      if (running.current) return
      running.current = true
      stack.current = stack.current.filter((item) => item !== entry)
      const current = captureRequestScope()
      void reverseChanges(entry.library, entry.changes)
        .then(async () => {
          current()
          await Promise.all(
            AFFECTED.map((name) => client.invalidateQueries({ queryKey: [name, entry.library] })),
          )
          notify.current({ text: `Undone: ${entry.text}` })
        })
        .catch((reason: Error) => {
          try {
            current()
          } catch {
            return
          }
          notify.current({ text: reason.message, alert: true })
        })
        .finally(() => {
          running.current = false
        })
    }
  }, [client])
  return useMemo(
    () => ({
      record: (text, changes) => {
        const planned = changes.every((change) => change !== null)
        const done = changes.filter((change): change is MembershipChange => change !== null)
        if (!planned || !done.some((change) => change.ids.length)) {
          notify.current({ text })
          return
        }
        const entry = { at: undoStamp(), library, text, changes: done }
        stack.current = [...stack.current.slice(1 - DEPTH), entry]
        notify.current({ text, action: { label: 'Undo', run: () => undo(entry) } })
      },
      newest: () => {
        const entry = stack.current.at(-1)
        return entry?.library === library ? { at: entry.at, run: () => undo(entry) } : null
      },
    }),
    [library, undo],
  )
}
