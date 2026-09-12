import { useEffect, useRef, useState } from 'react'
import { basisOf, rememberBasis } from '../api/editBasis'
import { libraryStateKey } from './useBundleDraft'

interface Draft<T> {
  value: T
  basis: string | undefined
}

// Match only the original scalar proposal, including the exact bulk selection
function matchesDraft(name: string, value: unknown, url: string, body: string): boolean {
  const [kind, identity, field] = name.split(':')
  const patch = JSON.parse(body) as Record<string, unknown>
  const target =
    kind === 'collection'
      ? `/collections/${identity}`
      : kind === 'moment'
        ? `/moments/${identity}`
        : '/bundles/batch-edit'
  if (!url.endsWith(target)) return false
  if (
    kind === 'bulk' &&
    JSON.stringify((patch.bundle_ids as string[] | undefined)?.slice().sort()) !==
      JSON.stringify(identity?.split(','))
  )
    return false
  const proposed = (kind === 'bulk' ? (patch.patch as Record<string, unknown>) : patch)?.[
    field ?? ''
  ]
  return proposed !== undefined && JSON.stringify(proposed ?? '') === JSON.stringify(value)
}

// Resolve private scalar drafts even when their original editor is no longer mounted
export function finishStoredFieldDrafts(url: string, body: string | undefined): void {
  if (!body) return
  const prefix = 'cairndex.fieldDraft:'
  const suffix = libraryStateKey('')
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    for (const key of keys) {
      if (!key) continue
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
      try {
        const draft = JSON.parse(localStorage.getItem(key) ?? 'null') as Draft<unknown> | null
        if (draft && matchesDraft(key.slice(prefix.length, -suffix.length), draft.value, url, body))
          localStorage.removeItem(key)
      } catch {
        // Leave unreadable or unremovable drafts intact for recovery
      }
    }
  } catch {
    // Mounted editors still receive completion when persistent storage is unavailable
  }
}

// Text fields keep their opening read basis and private input through refetches and navigation
export function useMetadataDraft<T>(name: string, current: T, source: unknown) {
  const key = libraryStateKey(`cairndex.fieldDraft:${name}`)
  const [initial] = useState<Draft<T> | null>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') as Draft<T> | null
    } catch {
      return null
    }
  })
  const [draft, setDraft] = useState(initial)
  const latest = useRef(draft)
  const [error, setError] = useState('')

  // Synchronous storage makes a blur or immediate navigation include the last keystroke
  const store = (next: Draft<T> | null) => {
    latest.current = next
    setDraft(next)
    try {
      if (next) localStorage.setItem(key, JSON.stringify(next))
      else localStorage.removeItem(key)
    } catch {
      setError('This draft is kept for this session; browser storage is unavailable.')
    }
  }
  useEffect(() => {
    const finished = (event: Event) => {
      const { url, body } = (event as CustomEvent<{ url: string; body?: string }>).detail
      if (!body || !latest.current) return
      if (matchesDraft(name, latest.current.value, url, body)) store(null)
    }
    window.addEventListener('cairndex:metadata-finished', finished)
    return () => window.removeEventListener('cairndex:metadata-finished', finished)
  })
  const begin = () => {
    if (!latest.current) store({ value: current, basis: basisOf(source) })
  }
  return {
    value: draft ? draft.value : current,
    error,
    begin,
    change: (value: T) =>
      store({
        value,
        basis: latest.current ? (latest.current.basis ?? 'unversioned-draft') : basisOf(source),
      }),
    bind: <V extends object>(variables: V): V =>
      rememberBasis(
        variables,
        latest.current ? (latest.current.basis ?? 'unversioned-draft') : basisOf(source),
      ),
    saved: (value: T) => {
      if (JSON.stringify(latest.current?.value) === JSON.stringify(value)) store(null)
    },
    discard: () => store(null),
  }
}
