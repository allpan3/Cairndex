import { useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { CatalogJobError, operationId } from '../api/catalog'
import { changeBundleMember, type BundleMemberChange } from '../api/catalogBundleMembers'
import { captureRequestScope } from '../api/requestScope'
import { useCatalogDraft } from './useCatalogDraft'

type Pending = {
  operation: string
  observed: Record<string, string[]>
  change: BundleMemberChange
}

function decode(raw: string): Pending | null {
  if (!raw) return null
  const pending = JSON.parse(raw) as Pending
  if (
    !pending ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(pending.operation) ||
    !pending.change ||
    !['move', 'remove', 'collapse', 'expand'].includes(pending.change.change) ||
    Object.keys(pending.change).some(
      (field) => !['change', 'entity', 'before', 'directory'].includes(field),
    ) ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(pending.change.entity) ||
    (pending.change.before != null && !/^[A-Za-z0-9_-]{1,64}$/.test(pending.change.before)) ||
    (pending.change.directory !== undefined && typeof pending.change.directory !== 'string') ||
    !pending.observed ||
    typeof pending.observed !== 'object' ||
    Array.isArray(pending.observed) ||
    !Object.values(pending.observed).every(
      (value) => Array.isArray(value) && value.every((v) => typeof v === 'string'),
    )
  )
    throw new Error('Invalid retained file operation')
  return pending
}

export function useCatalogBundleMembers(library: string, bundle: string) {
  const client = useQueryClient()
  const storage = useCatalogDraft(
    library,
    `bundle-files/${bundle}`,
    'ordinary',
    { data: '' },
    (body) => {
      try {
        decode(body.data)
        return true
      } catch {
        return false
      }
    },
  )
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState('')
  const pending = decode(storage.body.data)
  async function apply(change?: BundleMemberChange, observed?: Record<string, string[]>) {
    if (running.current) return false
    const intent =
      pending ?? (change && observed ? { operation: operationId(), change, observed } : null)
    if (!intent) return false
    running.current = true
    setBusy(true)
    setError('')
    const assertScope = captureRequestScope()
    try {
      storage.update({ data: JSON.stringify(intent) })
      await changeBundleMember(library, bundle, intent.observed, intent.change, intent.operation)
      assertScope()
      await storage.discard()
      await Promise.all(
        [
          'catalog-inspector-files',
          'catalog-album',
          'replica-media',
          'catalog-detail',
          'catalog-browse',
          'catalog-view-counts',
          'catalog-local-unbundled',
          'catalog-private-unbundled',
          'catalog-unbundled',
          'catalog-selection',
        ].map((key) => client.invalidateQueries({ queryKey: [key, library] })),
      )
      assertScope()
      window.dispatchEvent(new Event('cairndex:metadata-saved'))
      return true
    } catch (reason) {
      if (reason instanceof CatalogJobError) {
        try {
          await storage.discard()
        } catch {
          /* Retain the exact request if acknowledgement fails. */
        }
      }
      setError((reason as Error).message)
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return {
    apply,
    busy,
    pending,
    error: error || storage.error,
    copies: storage.copies,
    recover: (data: string) => storage.update({ data }),
  }
}
