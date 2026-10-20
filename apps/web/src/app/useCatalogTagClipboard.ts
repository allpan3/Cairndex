import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { copyCatalogTags, pasteCatalogTags } from '../api/catalogTagClipboard'
import { captureRequestScope } from '../api/requestScope'
import type { CatalogNotice } from './CatalogToast'

export function useCatalogTagClipboard(
  library: string,
  onNotice?: (notice: CatalogNotice) => void,
) {
  const client = useQueryClient()
  const running = useRef(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  async function run(action: () => Promise<string>, refresh = false) {
    if (running.current) return
    const current = captureRequestScope()
    running.current = true
    setBusy(true)
    setMessage('')
    try {
      const text = await action()
      current()
      setMessage(text)
      onNotice?.({ text })
    } catch (reason) {
      try {
        current()
      } catch {
        return
      }
      const text = (reason as Error).message
      setMessage(text)
      onNotice?.({ text, alert: true })
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
        const count = await pasteCatalogTags(library, ids)
        return `Pasted ${count} tag${count === 1 ? '' : 's'} onto ${ids.length} bundle${ids.length === 1 ? '' : 's'}.`
      }, true),
  }
}
