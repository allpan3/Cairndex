import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { copiedCatalogTags, copyCatalogTags, pasteCatalogTags } from '../api/catalogTagClipboard'
import { plannedChange, type MembershipChange } from '../api/catalogUndo'
import { captureRequestScope } from '../api/requestScope'
import { failureNotice } from './catalogBulkNotice'
import type { CatalogNotice } from './CatalogToast'
import { useOrganizeUndo } from './organizeUndo'

// A result, and for a paste in the browser the changes its Undo puts back
type Outcome = string | { text: string; changes: (MembershipChange | null)[] }

export function useCatalogTagClipboard(
  library: string,
  onNotice?: (notice: CatalogNotice) => void,
) {
  const client = useQueryClient()
  const undo = useOrganizeUndo()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(action: () => Promise<Outcome>, refresh = false) {
    if (running.current) return
    const current = captureRequestScope()
    running.current = true
    setBusy(true)
    setMessage('')
    try {
      const outcome = await action()
      current()
      if (typeof outcome === 'string' || !undo) {
        const text = typeof outcome === 'string' ? outcome : outcome.text
        setMessage(text)
        onNotice?.({ text })
      } else undo.record(outcome.text, outcome.changes)
    } catch (reason) {
      try {
        current()
      } catch {
        return
      }
      const text = (reason as Error).message
      setMessage(text)
      onNotice?.(failureNotice(reason as Error))
    } finally {
      let active = true
      try {
        current()
      } catch {
        active = false
      }
      if (refresh && active) {
        for (const name of [
          'catalog-selection',
          'catalog-memberships',
          'catalog-bulk-memberships',
          'catalog-browse',
          'catalog-detail',
          'catalog-navigation',
          'catalog-view-counts',
        ])
          void client.invalidateQueries({ queryKey: [name, library] })
      }
      running.current = false
      setBusy(false)
    }
  }
  return {
    busy,
    message,
    copy: (bundle: string) =>
      run(async () => {
        const count = await copyCatalogTags(library, bundle)
        return count
          ? `Copied ${count} tag${count === 1 ? '' : 's'}.`
          : 'That bundle has no tags to copy.'
      }),
    paste: (ids: string[]) =>
      run(async () => {
        // Read before pasting what each tag adds, so its Undo removes only those
        const changes: (MembershipChange | null)[] = []
        if (undo)
          for (const tag of copiedCatalogTags(library))
            changes.push(await plannedChange(library, ids, 'tags', tag, true))
        const count = await pasteCatalogTags(library, ids)
        const text = `Pasted ${count} tag${count === 1 ? '' : 's'} onto ${ids.length.toLocaleString()} bundle${ids.length === 1 ? '' : 's'}.`
        return undo ? { text, changes } : text
      }, true),
  }
}
